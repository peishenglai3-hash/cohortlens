/**
 * Output boundary vocabulary.
 *
 * Engineering Bible §24 (forbidden report content) and §18 (forbidden consistency vocabulary).
 * These phrases may never appear in anything the system shows a user about a person.
 *
 * This module exists so the boundary list has exactly one definition, shared by:
 *   - the role-fit engine, which masks them in generated role text;
 *   - the report chain, which masks them in model output before it is displayed or stored;
 *   - the validator, which reports the gap between this list and the frozen role-model file.
 *
 * It is a pure data module with no imports, so nothing can create a cycle through it.
 */

export const REQUIRED_FORBIDDEN_LANGUAGE = [
  // Essentialising conclusion labels (§24)
  '值得信任',
  '不值得信任',
  '危险人物',
  '就是这种人',
  '应当吸纳',
  '应当淘汰',
  // Political-reliability vocabulary (§3, §17, §24)
  '政治可靠',
  '政治不可靠',
  '政治忠诚',
  '忠诚',
  '意识形态纯度',
  // Deception vocabulary (§18)
  '撒谎概率',
  '欺骗指数',
  '真实性评分',
  '说谎',
  '诚实度',
] as const

/**
 * Admissions-decision vocabulary. Kept as its own list because it belongs to a different failure
 * than the report boundary: the report must not carry a verdict, and the UI must not dress a
 * dimension up as a pass/fail. The validator scans question text against the report list only,
 * since items legitimately talk *about* selection processes.
 */
export const ADMISSION_DECISION_LANGUAGE = [
  '录取',
  '淘汰',
  '通过率',
  '淘汰率',
  'PASS',
  'FAIL',
  '政治可靠',
  '政治不可靠',
] as const

/** Replacement text used when a phrase is masked. Kept explicit so a reader knows why. */
export const MASK_PLACEHOLDER = '[已按产品边界屏蔽]'

export interface MaskResult {
  text: string
  violations: string[]
}

/**
 * Replace every forbidden phrase, returning which ones were found.
 *
 * **Longest phrase first.** Masking the short form before the long one corrupts the result:
 * replacing `值得信任` inside `不值得信任` turns it into `不[已按产品边界屏蔽]`, which reads as a
 * negation of a mask and leaks the original intent. Sorting by length makes the longest match win,
 * so `不值得信任` is whole-masked and never partially rewritten.
 */
export function maskForbiddenLanguage(text: string, extra: readonly string[] = []): MaskResult {
  const violations: string[] = []
  let output = text
  const phrases = [...new Set([...REQUIRED_FORBIDDEN_LANGUAGE, ...extra])]
    .filter((phrase) => phrase.length > 0)
    .sort((a, b) => b.length - a.length)
  for (const phrase of phrases) {
    if (output.includes(phrase)) {
      violations.push(phrase)
      output = output.split(phrase).join(MASK_PLACEHOLDER)
    }
  }
  return { text: output, violations }
}

/** True when the text contains an admissions verdict or a pass/fail framing. */
export function containsAdmissionVerdict(text: string): string[] {
  return ADMISSION_DECISION_LANGUAGE.filter((phrase) => text.includes(phrase))
}
