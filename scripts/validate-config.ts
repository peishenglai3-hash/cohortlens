/**
 * `npm run validate:config` — Engineering Bible §51/§64.
 *
 * Checks the configuration layer rather than the question content:
 *   - `ProductConfig` points at content ids that actually exist in the loaded bundle, so a rename
 *     cannot silently point the app at a missing pack;
 *   - no API key material is present in any shipped content file (§30, release gate §20);
 *   - the built output, when present, contains no absolute `/assets/` reference (§42).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadContentBundle } from '../src/content/load-content.ts'
import { PRODUCT_CONFIG } from '../src/config/product.ts'

const problems: string[] = []
const notes: string[] = []

// --- product config vs loaded content ---------------------------------------
const { pack, scoring, roleModel } = loadContentBundle()

if (PRODUCT_CONFIG.assessment.questionPackId !== pack.id) {
  problems.push(
    `ProductConfig.assessment.questionPackId="${PRODUCT_CONFIG.assessment.questionPackId}" 与已加载题库 id "${pack.id}" 不一致`,
  )
}
if (PRODUCT_CONFIG.assessment.scoringModelId !== scoring.id) {
  problems.push(
    `ProductConfig.assessment.scoringModelId="${PRODUCT_CONFIG.assessment.scoringModelId}" 与评分模型 id "${scoring.id}" 不一致`,
  )
}
if (PRODUCT_CONFIG.assessment.roleModelId !== roleModel.id) {
  problems.push(
    `ProductConfig.assessment.roleModelId="${PRODUCT_CONFIG.assessment.roleModelId}" 与角色模型 id "${roleModel.id}" 不一致`,
  )
}
if (!PRODUCT_CONFIG.name.trim()) problems.push('ProductConfig.name 为空：产品名称必须可配置（§64）')

// --- no hard-coded key material in content ----------------------------------
const CONTENT_DIR = resolve(process.cwd(), 'content')
const KEY_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /api[_-]?key\s*[:=]\s*"[^"]{8,}"/i,
  /Bearer\s+[A-Za-z0-9._-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
]

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const contentFiles = walk(CONTENT_DIR)
for (const file of contentFiles) {
  const text = readFileSync(file, 'utf8')
  for (const pattern of KEY_PATTERNS) {
    if (pattern.test(text)) {
      problems.push(`content/ 下疑似存在 API Key：${file} 命中 ${pattern}`)
    }
  }
}
notes.push(`已扫描 content/ 下 ${contentFiles.length} 个文件，未发现 API Key 材料。`)

// --- provider presets ------------------------------------------------------
const providersPath = join(CONTENT_DIR, 'providers', 'providers.json')
if (existsSync(providersPath)) {
  const providers = JSON.parse(readFileSync(providersPath, 'utf8')) as { providers?: unknown[] }
  notes.push(`providers.json 存在，声明 ${providers.providers?.length ?? 0} 个预设。`)
} else {
  notes.push('content/providers/providers.json 尚未创建：Provider 层不在本切片范围内（ADR-004）。')
}

// --- built output, when present --------------------------------------------
const distIndex = resolve(process.cwd(), 'dist', 'index.html')
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, 'utf8')
  if (/(src|href)="\/assets\//.test(html)) {
    problems.push('dist/index.html 出现裸 /assets/ 绝对路径：子路径部署会 404（§42）')
  } else {
    notes.push('dist/index.html 未出现裸 /assets/ 绝对路径。')
  }
} else {
  notes.push('dist/ 不存在，跳过构建产物检查（先运行 npm run build）。')
}

console.log('='.repeat(78))
console.log('CohortLens 配置校验 validate:config')
console.log('='.repeat(78))
console.log(`产品名称      ${PRODUCT_CONFIG.name}`)
console.log(`题库          ${pack.id}@${pack.version}`)
console.log(`评分模型      ${scoring.id}@${scoring.version}`)
console.log(`角色模型      ${roleModel.id}@${roleModel.version}`)
console.log('')
for (const note of notes) console.log(`  [OK]   ${note}`)
for (const problem of problems) console.log(`  [ERROR] ${problem}`)
console.log('')

if (problems.length > 0) {
  console.error(`配置校验失败：${problems.length} 项。`)
  process.exit(1)
}
console.log('配置校验通过：ProductConfig 与已加载内容一致，未发现密钥材料。')
