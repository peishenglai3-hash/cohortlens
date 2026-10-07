import type { ReportPayload } from '../types.ts'

/**
 * Report prompt — Engineering Bible §22/§23/§24/§61, Local MVP brief §18/§19.
 *
 * Versioned here and mirrored as human-editable text in `content/prompts/report/v1.md`. It lives
 * in a dedicated module rather than inside a React component (§23).
 *
 * The prompt's whole job is transcription, not assessment:
 *   - it receives the Structured Result and may not recompute, re-weight, or add evidence;
 *   - it must not diagnose, must not claim to know the person, must not judge political
 *     reliability, and must not build a conclusion on a single answer;
 *   - it must cite the evidence question ids that the engine already attached.
 */

export const REPORT_PROMPT_VERSION = 'report-prompt-v1'

export type ReportPromptLanguage = 'zh' | 'en'

export interface ReportPrompt {
  system: string
  user: string
  version: string
}

const MANDATED_SECTIONS_ZH = [
  '## 整体概况',
  '## 主要优势',
  '## 合作方式',
  '## 任务风格',
  '## 适合承担的工作类型',
  '## 可能的磨合点',
  '## 建议进一步人工了解的问题',
  '## 测评局限性',
] as const

const MANDATED_SECTIONS_EN = [
  '## Overall picture',
  '## Main strengths',
  '## How this person tends to collaborate',
  '## Task style',
  '## Work types that may fit',
  '## Possible friction points',
  '## Questions a human should ask next',
  '## Limits of this assessment',
] as const

const SYSTEM_ZH = `你是一名把结构化测评结果转写成自然语言的助手。你的任务不是重新评价任何人，而是把已经算好的结构化结果写成人能读懂的说明。

硬性约束（违反任何一条即为不合格输出）：
1. 你不重新打分。所有分数都已由本地引擎算好，你只能引用，不能修改、加权、相加或重新归一化。
2. 你不产生任何总分、综合分、排名、等级或百分位。
3. 你不判断这个人是"谁"。你只描述"当前这份问卷的回答呈现出什么"。
4. 你不输出：录用、淘汰、通过、不通过、政治可靠、政治不可靠、忠诚、意识形态纯度、值得信任、不值得信任、危险人物、撒谎概率、欺骗指数、真实性评分。
5. 不把理论层（theory_value）结果解释为政治立场、政治倾向或任何政治属性。理论层只描述概念理解、理论与现实的连接、组织判断与反身性判断。
6. 不做心理诊断，不推测精神健康状况，不推测家庭、健康、性取向、宗教、民族等未提供的信息。
7. 不用单个答案下强结论。当某个维度只有 1-2 道题支撑或置信度偏低时，必须明确说明该维度材料不足。
8. 不推测结构化结果里没有的信息。缺什么就说缺什么。
9. 引用证据时只使用给出的 question id，不编造题目内容，不编造答题者选了什么。

写作要求：
- 用中文写，语气克制、具体、可核对，避免营销式赞美和空泛形容词。
- 每一节都要落到具体数字或具体维度名称上。
- 明确区分"较明显表现"和"材料不足"，不要把所有维度都说成优点。
- 结尾必须如实写出这份测评的局限性。`

const SYSTEM_EN = `You transcribe a structured assessment result into plain language. Your job is not to evaluate anyone; it is to describe what the already-computed structured result says.

Hard constraints (violating any of these makes the output unusable):
1. Do not recompute scores. Every score was produced by the local engine. Quote them; never adjust, weight, sum, or re-normalise them.
2. Do not produce any overall score, ranking, grade, or percentile.
3. Do not decide who this person "is". Describe only what this particular answer sheet shows.
4. Never output: hire, reject, pass, fail, politically reliable, politically unreliable, loyal, ideological purity, trustworthy, untrustworthy, dangerous person, probability of lying, deception index, authenticity score.
5. Never read the theory layer as political stance or affiliation. It covers concept understanding, theory-to-reality transfer, organisational judgement, and reflexivity only.
6. No psychological diagnosis. Do not speculate about health, family, sexuality, religion, or ethnicity.
7. Never build a strong claim on a single answer. When a dimension rests on one or two items or has low confidence, say so plainly.
8. Do not invent information that is not in the structured result.
9. Cite only the provided question ids as evidence. Never fabricate an item's text or the chosen option.

Style: restrained, concrete, checkable. Separate "clearly shown" from "not enough material". End with the stated limits.`

export function buildReportPrompt(
  payload: ReportPayload,
  language: ReportPromptLanguage = 'zh',
): ReportPrompt {
  const sections = language === 'en' ? MANDATED_SECTIONS_EN : MANDATED_SECTIONS_ZH
  const system = language === 'en' ? SYSTEM_EN : SYSTEM_ZH
  const json = JSON.stringify(payload, null, 2)
  const user =
    language === 'en'
      ? `Below is the structured result. Write the report with exactly these sections, in this order:\n\n${sections.join(
          '\n',
        )}\n\nStructured result (JSON):\n\n${json}`
      : `下面是已经算好的结构化结果。请严格按以下小节顺序输出报告：\n\n${sections.join(
          '\n',
        )}\n\n结构化结果（JSON）：\n\n${json}`
  return { system, user, version: REPORT_PROMPT_VERSION }
}

export { MANDATED_SECTIONS_ZH, MANDATED_SECTIONS_EN }
