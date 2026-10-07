/**
 * `npm run validate:questions` — Engineering Bible §51.
 *
 * Exits non-zero when any check reports an error, so CI (§47 "核心评分测试失败不得发布") can gate
 * on it. Warnings and inactive checks are printed but do not fail the run: an inactive check
 * means the pack has no material for that rule, which must be visible rather than fatal.
 */
import { loadContentBundle } from '../src/content/load-content.ts'
import { validateQuestionPack, type Finding, type Severity } from '../src/domain/validation.ts'
import { sampleQuestionSet } from '../src/engine/sampler.ts'
import { auditRoleModel } from '../src/engine/role-fit.ts'

const SEVERITY_MARK: Record<Severity, string> = {
  error: '[ERROR]   ',
  warning: '[WARN]    ',
  inactive: '[INACTIVE]',
  pass: '[OK]      ',
}

function printFinding(finding: Finding): void {
  console.log(`${SEVERITY_MARK[finding.severity]} ${finding.code}`)
  console.log(`           ${finding.message}`)
}

const bundle = loadContentBundle()
const { pack, scoring, roleModel } = bundle

// The sampler is run first so the report can state which §10 stages are actually live for this
// pack, instead of validating a pipeline that never executes.
const samplerRun = sampleQuestionSet({ pack, scoring, seed: 'validate:questions' })

const report = validateQuestionPack({
  pack,
  scoring,
  roleModel,
  samplerStages: samplerRun.stages,
})

const audit = auditRoleModel(roleModel, scoring)

console.log('='.repeat(78))
console.log('CohortLens 题库校验报告 validate:questions')
console.log('='.repeat(78))
console.log(`题库          ${pack.id}@${pack.version} (schemaVersion ${pack.schemaVersion})`)
console.log(`评分模型      ${scoring.id}@${scoring.version}`)
console.log(`角色模型      ${roleModel.id}@${roleModel.version}`)
console.log(`题目总数      ${report.counts.questions}`)
console.log(
  `校验结果      错误 ${report.counts.errors} / 警告 ${report.counts.warnings} / 未激活 ${report.counts.inactive} / 通过 ${report.counts.passed}`,
)
console.log(`总体判定      ${report.ok ? 'PASS' : 'FAIL'}`)
console.log('')

console.log('-'.repeat(78))
console.log('维度题量与单次配额')
console.log('-'.repeat(78))
for (const dimension of report.dimensions) {
  const pad =
    dimension.dimension.length >= 26
      ? dimension.dimension
      : dimension.dimension + ' '.repeat(26 - dimension.dimension.length)
  console.log(
    `  ${pad} ${dimension.layer.padEnd(22)} 题库 ${String(dimension.bankCount).padStart(3)} 题   单次至少 ${dimension.perAssessment} 题   ${dimension.label}`,
  )
}
console.log('')

console.log('-'.repeat(78))
console.log('角色模型静态审计（A 层不得进入角色适配）')
console.log('-'.repeat(78))
console.log(
  `  A 层维度泄漏进角色权重：${audit.layerAWeightViolations.length === 0 ? '无（正确）' : audit.layerAWeightViolations.join(', ')}`,
)
console.log(
  `  引用了不存在的维度：    ${audit.unknownWeightViolations.length === 0 ? '无（正确）' : audit.unknownWeightViolations.join(', ')}`,
)
console.log('')

console.log('-'.repeat(78))
console.log('逐项检查结果')
console.log('-'.repeat(78))
for (const finding of report.findings) printFinding(finding)
console.log('')

if (!report.ok) {
  console.error(`校验失败：${report.counts.errors} 项错误。`)
  process.exit(1)
}
console.log('校验通过：无错误项。警告与未激活项见上，需在交付说明中如实告知。')
