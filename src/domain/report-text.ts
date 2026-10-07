import type { AssessmentResult, Question, QuestionPack } from '../domain/schemas.ts'
import { LAYERS } from '../domain/schemas.ts'
import { formatPercent } from '../utils/ids.ts'

/**
 * Plain-text rendering of a Structured Result, shared by the demo script and the printable view.
 * Kept free of ASCII box-drawing characters so it renders correctly in a Windows console whose
 * code page is not UTF-8.
 */

const LAYER_TITLES: Record<(typeof LAYERS)[number], string> = {
  theory_value: 'A 层 / 理论与问题理解（不参与角色适配，不得解释为政治立场）',
  cooperation_behavior: 'B 层 / 合作与行为（自陈材料）',
  skill_role: 'C 层 / 技能与角色（自陈材料）',
}

function bar(score: number, width = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * width)
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`
}

function row(label: string, value: string, width = 22): string {
  const padded = label.length >= width ? label : label + ' '.repeat(width - label.length)
  return `  ${padded}${value}`
}

export function renderResultText(
  result: AssessmentResult,
  pack: QuestionPack,
  options: { verboseEvidence?: boolean; questions?: readonly Question[] } = {},
): string {
  const lines: string[] = []
  const byId = new Map(pack.questions.map((question) => [question.id, question]))
  const answered = Object.keys(result.evidence).length

  lines.push('='.repeat(78))
  lines.push('CohortLens 结构化结果（第一阶段本地评分，未调用任何 LLM）')
  lines.push('='.repeat(78))
  lines.push(row('结果 ID', result.id))
  lines.push(row('会话 ID', result.sessionId))
  lines.push(row('生成时间', result.generatedAt))
  lines.push(row('题库版本', result.versions.questionPack))
  lines.push(row('评分版本', result.versions.scoring))
  lines.push(row('角色模型版本', result.versions.roleModel))
  lines.push(
    row(
      '本次题量',
      `${result.evidence.length === 0 ? 0 : pack.assessmentPolicy.totalQuestions} 题（已答 ${answered} 题）`,
    ),
  )
  lines.push('')

  lines.push('-'.repeat(78))
  lines.push('一、维度画像 Profile Vector（系统不输出单一总分）')
  lines.push('-'.repeat(78))
  for (const layer of LAYERS) {
    const rows = result.dimensions.filter((dimension) => dimension.layer === layer)
    if (rows.length === 0) continue
    lines.push('')
    lines.push(LAYER_TITLES[layer])
    for (const dimension of rows) {
      lines.push(
        row(
          dimension.label,
          `${String(dimension.normalizedScore).padStart(3)} / 100  ${bar(dimension.normalizedScore)}  ${dimension.band}`,
        ),
      )
      lines.push(
        row(
          '',
          `原始分 ${dimension.rawScore}/${dimension.maxPossible}，题量 ${dimension.answeredItems}/${dimension.expectedItems}，置信度 ${formatPercent(dimension.confidence)}，证据题 ${dimension.evidenceQuestionIds.join(',')}`,
        ),
      )
      for (const warning of dimension.warnings ?? []) {
        lines.push(row('', `注意：${warning}`))
      }
      if (options.verboseEvidence) {
        for (const questionId of dimension.evidenceQuestionIds) {
          const question = byId.get(questionId)
          if (!question) continue
          const optionId = result.evidence.find((item) => item.questionId === questionId)?.optionId
          const option = question.options.find((candidate) => candidate.id === optionId)
          lines.push(row('', `  ${questionId} ${question.prompt}`))
          lines.push(row('', `    -> 作答：${option?.text ?? '(未作答)'}`))
        }
      }
    }
  }
  lines.push('')

  lines.push('-'.repeat(78))
  lines.push('二、角色适配 Role Fit（只使用 B / C 层维度，结构性排除 A 层）')
  lines.push('-'.repeat(78))
  for (const fit of result.roleFits) {
    lines.push(
      row(
        fit.name,
        `${String(fit.fitScore).padStart(3)} / 100  权重覆盖率 ${formatPercent(fit.coverage)}  参与维度 ${fit.contributingDimensions.join(',') || '(无)'}`,
      ),
    )
    lines.push(row('', fit.phrase))
    lines.push('')
  }

  lines.push('-'.repeat(78))
  lines.push('三、回答一致性与稳定度（不是"真实性"评分）')
  lines.push('-'.repeat(78))
  lines.push(row('回答一致性', formatPercent(result.consistency.answerConsistency)))
  lines.push(row('极端重复选择率', formatPercent(result.consistency.extremeRepeatRate)))
  lines.push(row('需要进一步了解', result.consistency.needsFurtherUnderstanding ? '是' : '否'))
  for (const finding of result.consistency.findings) {
    lines.push(
      row(
        finding.groupId,
        `${finding.label} | ${finding.questionIds.join('/')} | 置信度扣减 ${formatPercent(finding.confidencePenalty)}`,
      ),
    )
    lines.push(row('', finding.detail))
  }
  lines.push('')

  lines.push('-'.repeat(78))
  lines.push('四、抽题引擎阶段实际状态（未激活的阶段如实标注，不假装执行）')
  lines.push('-'.repeat(78))
  for (const stage of result.samplerStages) {
    lines.push(row(stage.stage, `${stage.active ? '[已激活]' : '[未激活]'} ${stage.reason}`))
  }
  lines.push('')

  lines.push('-'.repeat(78))
  lines.push('五、主要优势（仅描述本次答卷，不构成对人的判断）')
  lines.push('-'.repeat(78))
  for (const strength of result.strengths) lines.push(`  - ${strength}`)
  lines.push('')
  lines.push('-'.repeat(78))
  lines.push('六、可能需要更多信息的方向')
  lines.push('-'.repeat(78))
  for (const area of result.developmentAreas) lines.push(`  - ${area}`)
  lines.push('')

  lines.push('-'.repeat(78))
  lines.push('七、测评局限性')
  lines.push('-'.repeat(78))
  for (const limitation of result.limitations) lines.push(`  - ${limitation}`)
  lines.push('')
  lines.push('='.repeat(78))
  return lines.join('\n')
}
