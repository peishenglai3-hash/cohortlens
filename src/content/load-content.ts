import rawQuestionPack from '../../content/question-packs/v1/question-pack-v1.0.json'
import rawScoringModel from '../../content/scoring/v1/scoring-model-v1.0.json'
import rawRoleModel from '../../content/roles/v1/role-model-v1.0.json'
import {
  questionPackSchema,
  roleModelSchema,
  scoringModelSchema,
  type QuestionPack,
  type RoleModel,
  type ScoringModel,
} from '../domain/schemas.ts'

/**
 * Content loading — Engineering Bible §4 Schema First, §63 Fork Friendly, §9 pluggable packs.
 *
 * Content lives in `content/`, never inside a React component. Everything is parsed through Zod
 * at load time so a malformed pack fails loudly at startup instead of producing silently wrong
 * scores. The imports are static so the pack ships as a build asset and works offline (§35) with
 * no fetch, no server and no CORS.
 */

export class ContentLoadError extends Error {
  override readonly name = 'ContentLoadError'
  readonly issues: string[]

  constructor(label: string, issues: string[]) {
    super(`${label} 校验失败：\n- ${issues.join('\n- ')}`)
    this.issues = issues
  }
}

function formatIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues
    .slice(0, 25)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

function parseOrThrow<T>(
  label: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  value: unknown,
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ContentLoadError(label, formatIssues(result.error))
  return result.data
}

export const QUESTION_PACK: QuestionPack = parseOrThrow(
  'Question Pack cohortlens-cn-v1',
  questionPackSchema,
  rawQuestionPack,
)

export const SCORING_MODEL: ScoringModel = parseOrThrow(
  'Scoring Model scoring-v1',
  scoringModelSchema,
  rawScoringModel,
)

export const ROLE_MODEL: RoleModel = parseOrThrow(
  'Role Model roles-v1',
  roleModelSchema,
  rawRoleModel,
)

export interface ContentBundle {
  pack: QuestionPack
  scoring: ScoringModel
  roleModel: RoleModel
}

/** The single content bundle the app runs on. Swap this object to swap a whole question pack. */
export function loadContentBundle(): ContentBundle {
  return { pack: QUESTION_PACK, scoring: SCORING_MODEL, roleModel: ROLE_MODEL }
}
