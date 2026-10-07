import { describe, expect, it } from 'vitest'
import { maskForbiddenLanguage, REQUIRED_FORBIDDEN_LANGUAGE } from '../../src/domain/boundaries.ts'
import { createProvider } from '../../src/infrastructure/ai/factory.ts'
import { buildReportPayload } from '../../src/infrastructure/ai/report-payload.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../../src/engine/assessment.ts'
import { loadContentBundle } from '../../src/content/load-content.ts'
import { DEFAULT_PROVIDER_CONFIG } from '../../src/config/provider-config.ts'

/**
 * Boundary-filter invariants.
 *
 * The mask runs on model output before it is displayed or stored, so it has to be correct by
 * construction rather than by luck of ordering. The first version of it had a real bug: masking
 * `值得信任` before the longer `不值得信任` rewrote the latter into `不[已按产品边界屏蔽]`, which
 * reads as a *negation of a mask* and leaks the original intent. These tests pin the invariant
 * that no forbidden phrase — of any length — survives the filter, including as a fragment.
 */

const bundle = loadContentBundle()
const { pack } = bundle

const mockConfig = {
  ...DEFAULT_PROVIDER_CONFIG,
  providerId: 'mock',
  baseURL: 'https://mock.local/v1',
  model: 'mock-report-model',
}

function completedRun(seed: string) {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: `sess_${seed}`,
    createdAt: '2026-10-07T12:00:00.000Z',
  })
  const answers = simulateAnswers(paperQuestions(bundle, created.session), seed)
  return completeAssessment(
    bundle,
    { ...created.session, answers },
    {
      generatedAt: '2026-10-07T12:00:00.000Z',
    },
  )
}

/** Every forbidden phrase, as a list, so a failure names the offender. */
function survivingPhrases(text: string): string[] {
  return REQUIRED_FORBIDDEN_LANGUAGE.filter((phrase) => text.includes(phrase))
}

describe('maskForbiddenLanguage invariants', () => {
  it('masks a longer phrase whole rather than letting a shorter one carve it up', () => {
    const result = maskForbiddenLanguage('这个人不值得信任，但值得信任的是他的方法。')
    expect(result.text).not.toContain('值得信任')
    expect(result.text).not.toContain('不值得信任')
    expect(result.text).not.toContain('不[已按产品边界屏蔽]')
    expect(result.violations).toContain('不值得信任')
  })

  it('leaves no forbidden phrase behind in any of the boundary sentences', () => {
    const sentences = [
      '不得输出值得信任/不值得信任/危险人物/撒谎概率等决定性标签。',
      '不得判断政治可靠、政治忠诚或意识形态纯度。',
      '不得输出录用、淘汰、通过、不通过等结论。',
      '不得声称了解参与者真实人格，不得做心理诊断。',
      '就是这种人，应当吸纳或应当淘汰，政治不可靠，欺骗指数很高，真实性评分很低，诚实度不足，在说谎。',
    ]
    for (const sentence of sentences) {
      const masked = maskForbiddenLanguage(sentence)
      expect(survivingPhrases(masked.text), `survivors in: ${sentence}`).toEqual([])
    }
  })

  it('keeps masking until the text is stable (order-independent fixpoint)', () => {
    const adversarial = '不值得信任值得信任不值得信任'
    const once = maskForbiddenLanguage(adversarial)
    const twice = maskForbiddenLanguage(once.text)
    expect(survivingPhrases(once.text)).toEqual([])
    expect(twice.text).toBe(once.text)
    expect(twice.violations).toEqual([])
  })

  it('reports every phrase it actually found', () => {
    const result = maskForbiddenLanguage('危险人物，撒谎概率高，政治可靠。')
    expect(new Set(result.violations)).toEqual(new Set(['危险人物', '撒谎概率', '政治可靠']))
  })
})

describe('the real mock report passes the boundary filter', () => {
  it('contains no forbidden phrase after masking', async () => {
    const { result } = completedRun('boundary-mock')
    const payload = buildReportPayload({ result, pack })
    const provider = createProvider(mockConfig)
    const generated = await provider.generateReport(mockConfig, 'placeholder', payload)

    // The raw mock output deliberately restates the boundary list, which is the adversarial case.
    const masked = maskForbiddenLanguage(generated.content)
    expect(
      survivingPhrases(masked.text),
      `survivors found: ${survivingPhrases(masked.text).join(', ')}`,
    ).toEqual([])
  })

  it('is stable when masked twice', async () => {
    const { result } = completedRun('boundary-mock-2')
    const payload = buildReportPayload({ result, pack })
    const provider = createProvider(mockConfig)
    const generated = await provider.generateReport(mockConfig, 'placeholder', payload)
    const once = maskForbiddenLanguage(generated.content)
    const twice = maskForbiddenLanguage(once.text)
    expect(twice.text).toBe(once.text)
  })
})
