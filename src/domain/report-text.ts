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

  /**
   * A-layer V1.1 gets its own six-part section instead of score rows: A0 has no number at all,
   * A2-A4 are issue positions, and A5 is qualitative. Printing them as "0 / 100" rows would read as
   * a scoreboard, which is exactly what the A-layer policy forbids (DSH-MIGRATION-V1.1 §5).
   */
  if (result.aLayerProfile) {
    const profile = result.aLayerProfile
    lines.push('')
    lines.push('A 层 / 思想认同与政治—理论画像（自愿自报，不参与角色适配，不生成任何综合分）')
    for (const boundary of profile.boundaries) lines.push(row('', `边界：${boundary}`))

    lines.push('')
    lines.push('  1 · 自我声明的理论认同（A0，直接自报，无分数）')
    if (profile.declaredIdentity.length === 0) {
      lines.push(row('', '(本次未作答或未抽到)'))
    }
    for (const item of profile.declaredIdentity) {
      lines.push(row(`    ${item.questionId}`, item.topic))
      lines.push(row('', `      -> 本人选择：${item.selectedText}`))
      lines.push(row('', `         自报类别：${item.selectedCategory}`))
    }

    lines.push('')
    lines.push('  2 · 理论熟悉程度（A1，低精度提示 low sample）')
    if (profile.theoryFamiliarity) {
      const familiarity = profile.theoryFamiliarity
      lines.push(
        row(
          '    答对 / 作答',
          `${familiarity.correct} / ${familiarity.answered}（${familiarity.normalizedScore} / 100，${familiarity.band}）`,
        ),
      )
      lines.push(row('', `      ${familiarity.note}`))
      lines.push(row('', `      证据题 ${familiarity.evidenceQuestionIds.join(',')}`))
    } else {
      lines.push(row('', '(本次未抽到 A1 题目)'))
    }

    const cardSections: [string, typeof profile.politicalEconomy][] = [
      ['  3 · 政治经济议题立场（A2，原始立场，不折算分数）', profile.politicalEconomy],
      ['  4 · 社会—政治议题立场（A3，原始立场，不折算分数）', profile.socialPolitical],
      ['  5 · 实践取向（A4，原始取向，不折算分数）', profile.practiceOrientation],
    ]
    for (const [title, cards] of cardSections) {
      lines.push('')
      lines.push(title)
      if (cards.length === 0) lines.push(row('', '(本次未作答或未抽到)'))
      for (const card of cards) {
        lines.push(row(`    ${card.questionId}`, card.prompt))
        lines.push(row('', `      -> 本人选择：${card.selectedText}`))
      }
    }

    lines.push('')
    lines.push('  6 · 反身性与修正方式（A5）')
    lines.push(
      row(
        '    状态',
        `${profile.reflexivity.state}${profile.reflexivity.confidence > 0 ? `（置信度 ${formatPercent(profile.reflexivity.confidence)}）` : ''}`,
      ),
    )
    lines.push(row('', `      ${profile.reflexivity.summary}`))
    for (const questionId of profile.reflexivity.evidenceQuestionIds) {
      const question = byId.get(questionId)
      if (!question) continue
      lines.push(row('', `      ${questionId} ${question.prompt}`))
    }
  }

  for (const layer of LAYERS) {
    // With an A-layer profile present, layer A is already printed above as six narrative parts.
    if (layer === 'theory_value' && result.aLayerProfile) continue
    const rows = result.dimensions.filter((dimension) => dimension.layer === layer)
    if (rows.length === 0) continue
    lines.push('')
    lines.push(LAYER_TITLES[layer])
    for (const dimension of rows) {
      const numeric = (dimension.scoredItems ?? 1) > 0
      if (!numeric) {
        lines.push(row(dimension.label, `不产生分数（本次作答 ${dimension.answeredItems} 题）`))
        for (const warning of dimension.warnings ?? []) {
          lines.push(row('', `注意：${warning}`))
        }
        continue
      }
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
