import rawQuestionPack from '../../content/question-packs/v1/question-pack-v1.1.json'
import rawScoringModel from '../../content/scoring/v1/scoring-model-v1.1.json'
import rawALayerScoring from '../../content/scoring/v1/a-scoring-model-v1.1.json'
import rawAResultSchema from '../../content/scoring/v1/a-result-schema-v1.1.json'
import rawRoleModel from '../../content/roles/v1/role-model-v1.0.json'
import {
  aResultSchemaDocSchema,
  aScoringModelSchema,
  questionPackSchema,
  roleModelSchema,
  scoringModelSchema,
  type AResultSchemaDoc,
  type AScoringModel,
  type QuestionPack,
  type RoleModel,
  type ScoringModel,
} from '../domain/schemas.ts'

/**
 * Content loading — Engineering Bible §4 Schema First, §63 Fork Friendly, §9 pluggable packs.
 *
 * Content lives in `content/`, never inside a React component. Everything is parsed through Zod at
 * load time so a malformed pack fails loudly at startup instead of producing silently wrong scores.
 * The imports are static, so the pack ships as a build asset and works offline (§35) with no fetch,
 * no server and no CORS.
 *
 * Version note (A-layer V1.1 migration): the active bundle is
 * `cohortlens-question-pack-v1.1` + `scoring-v1.1`, whose A layer is six dimensions
 * (A0-A5) sampled 2/3/3/3/2/2. The V1.0 bundle is retained under `content/**\/_legacy-v1.0/` for
 * provenance only; it is deliberately **not** imported, so it is not bundled and cannot be selected
 * by accident. A V1.0 session therefore cannot be re-scored by this build — the version guard in
 * `scoreAssessment` refuses it with an explicit message instead of silently reinterpreting it.
 */

export class ContentLoadError extends Error {
  override readonly name = 'ContentLoadError'
  readonly issues: string[]

  constructor(label: string, issues: string[]) {
    super(`${label} 校验失败：\n- ${issues.join('\n- ')}`)
    this.issues = issues
  }
}

function formatIssues(error: {
  issues: { path: (string | number)[]; message: string }[]
}): string[] {
  return error.issues
    .slice(0, 25)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

function parseOrThrow<T>(
  label: string,
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }
  },
  value: unknown,
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ContentLoadError(label, formatIssues(result.error))
  return result.data
}

export const QUESTION_PACK: QuestionPack = parseOrThrow(
  'Question Pack cohortlens-question-pack-v1.1',
  questionPackSchema,
  rawQuestionPack,
)

export const SCORING_MODEL: ScoringModel = parseOrThrow(
  'Scoring Model scoring-v1.1',
  scoringModelSchema,
  rawScoringModel,
)

export const ROLE_MODEL: RoleModel = parseOrThrow(
  'Role Model roles-v1.0',
  roleModelSchema,
  rawRoleModel,
)

/** Standalone A-layer policy: what each A dimension may and may not be shown as. */
export const A_LAYER_SCORING: AScoringModel = parseOrThrow(
  'A-layer Scoring Model cohortlens-a-scoring-v1.1',
  aScoringModelSchema,
  rawALayerScoring,
)

/** A-layer result shape. Used to assert that forbidden fields are never produced. */
export const A_RESULT_SCHEMA_DOC: AResultSchemaDoc = parseOrThrow(
  'A-layer Result Schema cohortlens-a-result-v1.1',
  aResultSchemaDocSchema,
  rawAResultSchema,
)

export interface ContentBundle {
  pack: QuestionPack
  scoring: ScoringModel
  roleModel: RoleModel
  aLayer: AScoringModel
  aResultSchema: AResultSchemaDoc
}

/** The single content bundle the app runs on. Swap this object to swap a whole question pack. */
export function loadContentBundle(): ContentBundle {
  return {
    pack: QUESTION_PACK,
    scoring: SCORING_MODEL,
    roleModel: ROLE_MODEL,
    aLayer: A_LAYER_SCORING,
    aResultSchema: A_RESULT_SCHEMA_DOC,
  }
}
