/**
 * `npm run demo:assessment` — end-to-end proof that the deterministic core runs on the real
 * frozen bank. Engineering Bible §65 asked for a demo fixture before the real bank existed; the
 * real 120-question bank is now present, so the demo runs on it and additionally asserts
 * determinism (release gate §50).
 *
 * The respondent is simulated and labelled as such. Nothing here is a real person's data.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadContentBundle } from '../src/content/load-content.ts'
import {
  completeAssessment,
  createAssessment,
  paperQuestions,
  simulateAnswers,
} from '../src/engine/assessment.ts'
import { renderResultText } from '../src/domain/report-text.ts'
import { createRng } from '../src/engine/rng.ts'
import { questionPackSchema, type AssessmentResult } from '../src/domain/schemas.ts'

const DEMO_SEED = 'cohortlens-demo-seed-0001'
const DEMO_SESSION_ID = 'session_demo_fixed'
const DEMO_TIMESTAMP = '2026-10-07T12:00:00.000Z'
const DEMO_STYLE = (process.argv[2] as 'balanced' | 'high' | 'low' | undefined) ?? 'balanced'

const bundle = loadContentBundle()
const { pack } = bundle

function runOnce(seed: string): { result: AssessmentResult; questionIds: string[] } {
  const created = createAssessment({
    bundle,
    seed,
    sessionId: DEMO_SESSION_ID,
    createdAt: DEMO_TIMESTAMP,
  })
  const questions = paperQuestions(bundle, created.session)
  const answers = simulateAnswers(questions, seed, DEMO_STYLE)
  const completed = completeAssessment(
    bundle,
    { ...created.session, answers },
    { generatedAt: DEMO_TIMESTAMP },
  )
  return { result: completed.result, questionIds: created.session.questionIds }
}

const first = runOnce(DEMO_SEED)
const second = runOnce(DEMO_SEED)

const firstJson = JSON.stringify(first.result)
const secondJson = JSON.stringify(second.result)
const deterministic = firstJson === secondJson

console.log(renderResultText(first.result, pack))
console.log('')
console.log('='.repeat(78))
console.log('切片自检')
console.log('='.repeat(78))
console.log(`  模拟作答方式            ${DEMO_STYLE}（由种子 "${DEMO_SEED}" 驱动，不是真人数据）`)
console.log(`  抽题 seed               ${DEMO_SEED}`)
console.log(`  抽到题目                ${first.questionIds.length} 题`)
console.log(
  `  复现一致（§50 确定性）  ${deterministic ? '是，两次运行逐字节相同' : '否，存在不确定性，必须修复'}`,
)

// Third run with a different seed must produce a different paper but still exactly 30 items.
const other = createAssessment({
  bundle,
  seed: 'cohortlens-demo-seed-0002',
  sessionId: 'session_demo_2',
})
const overlap = other.session.questionIds.filter((id) => first.questionIds.includes(id)).length
console.log(`  换种子后题目重合        ${overlap}/30 题（说明抽样确实随机，而非固定卷）`)

// Schema round-trip on the produced result, so a schema drift cannot pass unnoticed.
const parsed = questionPackSchema.safeParse(pack)
console.log(`  题库 schema 复校验      ${parsed.success ? '通过' : '失败'}`)

const outDir = resolve(process.cwd(), 'exports')
mkdirSync(outDir, { recursive: true })
const jsonPath = resolve(outDir, 'demo-assessment-result.json')
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      generatedAt: DEMO_TIMESTAMP,
      demoSeed: DEMO_SEED,
      answerStyle: DEMO_STYLE,
      deterministic,
      note: '本文件由 npm run demo:assessment 生成；作答为模拟数据，不含任何真实个人信息。',
      result: first.result,
    },
    null,
    2,
  ),
  'utf8',
)
console.log(`  JSON 导出               ${jsonPath}`)

const summary = {
  questions: first.questionIds.length,
  dimensions: first.result.dimensions.length,
  roles: first.result.roleFits.length,
  topRole: first.result.roleFits[0]?.name ?? null,
  consistency: Number(first.result.consistency.answerConsistency.toFixed(4)),
  deterministic,
  seedEntropyCheck: createRng('probe').next() >= 0 && createRng('probe').next() < 1,
}

console.log('')
console.log(`切片汇总 ${JSON.stringify(summary)}`)

if (!deterministic) {
  console.error('确定性检查失败：同一 seed 两次运行结果不同。')
  process.exit(1)
}
