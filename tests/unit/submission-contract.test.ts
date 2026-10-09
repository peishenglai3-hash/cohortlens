import { describe, expect, it } from 'vitest'
import { loadContentBundle } from '../../src/content/load-content.ts'
import { SUBMISSION_FORMAT_VERSION, reviewSummarySchema } from '../../src/domain/submission.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import {
  buildDimensionMap,
  deriveMaterial,
  summarizeSubmission,
} from '../../worker/review-summary.ts'

/**
 * 审阅摘要的契约测试。
 *
 * 这个文件存在的理由是一条产品边界：审阅台**不能**出现"系统建议""是否通过""综合排名"这样的东西。
 * 边界写在文档里是会被忘掉的，写在类型里也只是"暂时没人加"，所以这里遍历序列化结果把它钉住——
 * 将来有人想加一个 `recommendation` 字段，会先撞到这几条用例。
 */

const bundle = loadContentBundle()
const FIXED_TIME = '2026-10-09T12:00:00.000Z'

function run(seed: string) {
  const created = createAssessment({ bundle, seed, sessionId: `s_${seed}`, createdAt: FIXED_TIME })
  const answers = simulateAnswers(paperQuestions(bundle, created.session), seed)
  return completeAssessment(bundle, { ...created.session, answers }, { generatedAt: FIXED_TIME })
}

function coreFor(seed: string) {
  const { session, result } = run(seed)
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    submittedAt: FIXED_TIME,
    assessedAt: session.completedAt ?? session.updatedAt,
    versions: {
      questionPackId: session.questionPackId,
      questionPackVersion: session.questionPackVersion,
      scoringVersion: session.scoringVersion,
      roleModelVersion: session.roleModelVersion,
    },
    session,
    result,
  }
}

function summaryFor(seed: string) {
  const core = coreFor(seed)
  return summarizeSubmission({
    submissionId: `sub_${seed}`,
    receivedAt: FIXED_TIME,
    inviteLabel: '测试批次',
    contact: { kind: 'email', value: 'r@example.com' },
    core,
    dimensionOf: buildDimensionMap(core),
  })
}

describe('审阅摘要 —— 不含任何"系统替你做判断"的字段', () => {
  it('parses against the published contract', () => {
    const summary = summaryFor('contract')
    expect(() => reviewSummarySchema.parse(summary)).not.toThrow()
  })

  it('exposes no top-level field that could hold a verdict or a rank', () => {
    /**
     * Checked on the keys, not by searching the serialised JSON for words. A substring scan is both
     * weak (it matches a seed like "no-verdict" inside an id, which is how this test first failed)
     * and blind to a well-named field. The key list is what a future contributor must actually edit.
     */
    const summary = summaryFor('field-shape')
    const allowed = new Set([
      'submissionId',
      'receivedAt',
      'assessedAt',
      'inviteLabel',
      'contact',
      'versions',
      'material',
      'dimensions',
      'roleFits',
      'aLayer',
      'limitations',
      'decision',
    ])
    for (const key of Object.keys(summary)) {
      expect(allowed.has(key), `unexpected summary field "${key}"`).toBe(true)
    }
    // The only decision field is the reviewer's own, and it starts empty.
    expect(summary.decision).toBeNull()
    // Role fit is the closest thing to a comparison, and it must stay a per-role measure with its
    // coverage attached rather than collapsing into one number about the person.
    for (const fit of summary.roleFits) {
      expect(Object.keys(fit).sort()).toEqual([
        'contributingDimensions',
        'coverage',
        'fitScore',
        'name',
        'roleId',
      ])
    }
  })

  it('starts every submission undecided, so a reviewer must actually decide', () => {
    expect(summaryFor('undecided').decision).toBeNull()
  })
})

describe('材料充分度是机械度量，不是质量评分', () => {
  it('reports the paper that was actually answered, not the whole bank', () => {
    const core = coreFor('material-分母')
    const material = deriveMaterial(core.session, core.result, buildDimensionMap(core))
    // A 30-item paper answered in full must read as 100%, not as 30/120.
    expect(material.totalItems).toBe(core.session.questionIds.length)
    expect(material.answeredItems).toBe(material.totalItems)
    expect(material.completionRatio).toBe(1)
    expect(material.thinDimensions).toEqual([])
  })

  it('detects an unanswered item as missing material rather than as a low score', () => {
    const core = coreFor('material-缺答')
    const droppedId = core.session.questionIds[0] ?? ''
    const answers = { ...core.session.answers }
    delete answers[droppedId]
    const partial = { ...core.session, answers }

    /**
     * The dimension map must come from **this** submission's own result. Getting the subject wrong
     * here is easy and silent: an earlier version of this test built the map from a different paper
     * (the helper's default seed), so the dropped question was often absent from the map and the
     * assertion failed for a reason that had nothing to do with the production code.
     */
    const material = deriveMaterial(partial, core.result, buildDimensionMap(core))
    expect(material.answeredItems).toBe(material.totalItems - 1)
    expect(material.completionRatio).toBeLessThan(1)

    const dimensionOfDropped = paperQuestions(bundle, core.session).find(
      (question) => question.id === droppedId,
    )?.dimension
    expect(dimensionOfDropped).toBeTruthy()
    expect(material.thinDimensions).toContain(dimensionOfDropped)
  })

  it('does NOT call a dimension thin merely because the bank gives it 1-2 items', () => {
    /**
     * This is the defect the real-data screenshot surfaced: with the first rule ("answered <= 2"),
     * almost every B/C dimension was listed as thin, because those layers only draw one or two items
     * per dimension by design. A warning that always fires is worse than no warning — it buries the
     * case that actually matters (a dimension with no answer at all).
     */
    const core = coreFor('material-薄维度噪声')
    const material = deriveMaterial(core.session, core.result, buildDimensionMap(core))
    expect(material.thinDimensions).toEqual([])

    // And the per-dimension evidence is exposed so the reviewer can check it themselves.
    expect(material.coverage.length).toBeGreaterThan(0)
    for (const entry of material.coverage.filter((item) => item.expectedItems > 0)) {
      expect(entry.answeredItems).toBeGreaterThanOrEqual(entry.expectedItems)
    }
  })
})

describe('A 层在审阅台里的呈现', () => {
  it('passes the six parts through without ever producing a combined A number', () => {
    const summary = summaryFor('a-layer')
    expect(summary.aLayer).not.toBeNull()
    expect(summary.aLayer?.boundaries.length).toBeGreaterThan(2)

    const aLayerJson = JSON.stringify(summary.aLayer)
    for (const forbidden of ['total', 'score', 'index', 'aggregate']) {
      expect(aLayerJson, forbidden).not.toContain(forbidden)
    }
  })

  it('keeps the self-declared identity verbatim, including its own category', () => {
    const summary = summaryFor('a0-verbatim')
    for (const entry of summary.aLayer?.declaredIdentity ?? []) {
      expect(entry.selectedCategory.length).toBeGreaterThan(0)
      expect(entry.selectedText.length).toBeGreaterThan(0)
    }
  })

  it('never lists an A-layer dimension among the role-fit contributors', () => {
    for (let index = 0; index < 5; index += 1) {
      const summary = summaryFor(`rolefit-${index}`)
      for (const fit of summary.roleFits) {
        for (const dimension of fit.contributingDimensions) {
          expect(dimension.startsWith('A'), `${fit.roleId} -> ${dimension}`).toBe(false)
        }
      }
    }
  })

  it('marks A-layer dimensions so the console cannot render them as comparable scores', () => {
    const summary = summaryFor('a-kind')
    const aDimensions = summary.dimensions.filter((dimension) => dimension.layer === 'theory_value')
    expect(aDimensions.length).toBeGreaterThan(0)
    for (const dimension of aDimensions) {
      expect(['categorical', 'descriptive', 'knowledge']).toContain(dimension.scoringKind)
    }
  })
})
