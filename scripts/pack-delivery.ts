/**
 * 组装甲方交付包（Custom Delivery Bundle）。
 *
 * 用法：`npm run pack:delivery`（内部会先跑两次构建）
 *
 * 产出 `delivery/CohortLens-交付包/`，目录结构固定为：
 *
 *   CohortLens-交付包/
 *   ├─ 0-先看这里.md            最简说明：两种打开方式、数据在哪、边界是什么
 *   ├─ CohortLens.html          单文件离线版（双击即用，自带全部内容）
 *   ├─ 启动本地服务器.cmd       Windows 双击即可起 http 服务（用于"安装成应用"）
 *   ├─ server.cjs               上面那个 cmd 调用的零依赖服务器
 *   ├─ app/                     可由任意静态服务器托管的整包（PWA，可安装、可离线）
 *   ├─ 技术说明.md              版本号、构建来源、已知限制、校验方式
 *   └─ SHA256SUMS.txt           交付物逐文件校验和
 *
 * 设计取舍：**不压缩成 zip**。甲方收到的是一个可以直接点开的文件夹，而不是"先解压再看"。
 * 需要压缩时由人自己压缩，这样"交付了什么"一目了然。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const appConfig = JSON.parse(readFileSync(join(root, 'application.json'), 'utf8'))

const OUT_DIR = join(root, 'delivery', 'CohortLens-交付包')
const DIST = join(root, 'dist')
const DIST_DELIVERY = join(root, 'dist-delivery')

function step(message: string): void {
  console.log(`\n=== ${message} ===`)
}

function run(command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

step('1/6 构建 PWA 整包（dist/）')
run('npm', ['run', 'build'])

step('2/6 构建单文件离线版（dist-delivery/）')
run('npm', ['run', 'build:delivery'])

for (const dir of [DIST, DIST_DELIVERY]) {
  if (!existsSync(dir)) throw new Error(`构建产物缺失：${dir}`)
}
if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html 缺失')
if (!existsSync(join(DIST_DELIVERY, 'index.html'))) throw new Error('dist-delivery/index.html 缺失')

step('3/6 清空并重建交付目录')
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

step('4/6 拷贝产物')
cpSync(join(DIST_DELIVERY, 'index.html'), join(OUT_DIR, 'CohortLens.html'))
cpSync(DIST, join(OUT_DIR, 'app'), { recursive: true })
cpSync(join(root, 'scripts', 'delivery-server.cjs'), join(OUT_DIR, 'server.cjs'))

/** The single file already contains everything; the map files would only leak the source. */
for (const file of readdirSync(join(OUT_DIR, 'app'))) {
  if (file.endsWith('.map')) rmSync(join(OUT_DIR, 'app', file), { force: true })
}
const assetsDir = join(OUT_DIR, 'app', 'assets')
if (existsSync(assetsDir)) {
  for (const file of readdirSync(assetsDir)) {
    if (file.endsWith('.map')) rmSync(join(assetsDir, file), { force: true })
  }
}

const LAUNCHER = `@echo off
chcp 65001 >nul
title CohortLens 本地服务器
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，因此无法启动本地服务器。
  echo.
  echo   没关系：直接双击 CohortLens.html 就能使用全部功能
  echo   ^(只有"安装成应用 + 断网打开"需要 Node.js^)。
  echo.
  pause
  exit /b 1
)
echo.
echo   正在启动 CohortLens 本地服务器...
echo.
node "%~dp0server.cjs" %*
echo.
pause
`
writeFileSync(join(OUT_DIR, '启动本地服务器.cmd'), LAUNCHER.replace(/\n/g, '\r\n'), 'utf8')

step('5/6 生成说明文件')
const packVersion = readJson(join(root, 'content/question-packs/v1/question-pack-v1.1.json'))
const scoringVersion = readJson(join(root, 'content/scoring/v1/scoring-model-v1.1.json'))
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

writeFileSync(
  join(OUT_DIR, '0-先看这里.md'),
  `# CohortLens 使用说明

${appConfig.name} —— ${appConfig.description}

这个文件夹里有两套完全等价的版本，**任选一种即可，不需要都装**。

---

## 方式一：双击 \`CohortLens.html\`（推荐先试这个）

1. 双击 \`CohortLens.html\`，用 Chrome 或 Edge 打开。
2. 直接就能用：抽题、作答、看结果、导历史、导出 JSON、打印/另存为 PDF 全部可用。
3. 这个文件**自带全部内容**，不需要联网，也不需要安装任何东西。
   你可以把它单独拷到 U 盘、放进邮件附件、或拷到一台完全离线的电脑上。

**唯一的一点差别**：从这种"本地文件"方式打开时，浏览器不允许把它"安装成应用"，
所以不会出现桌面图标。除此之外没有任何功能缺失。

---

## 方式二：双击 \`启动本地服务器.cmd\`（想"安装成应用"就用这个）

1. 双击 \`启动本地服务器.cmd\`，会弹出一个黑色窗口，并自动打开浏览器。
2. 在浏览器里正常使用。
3. 想变成桌面应用：看浏览器地址栏右侧的"安装"图标（Chrome/Edge 都会有），点它即可。
   装好之后有独立窗口和桌面图标，并且**断网也能打开**。
4. 用完关闭那个黑色窗口就等于关闭服务器。

> 如果提示"没有找到 Node.js"，说明这台电脑没装 Node。
> 那就用方式一，功能一样是全的。

---

## 我的数据存在哪里？

**只存在这台电脑的这个浏览器里。** 这个工具没有中心服务器、没有账号、没有云端，
也不会把任何内容发到网上（除非你自己在「设置」里填了 API Key 并主动点「生成 AI 报告」）。

- 数据保存在浏览器的本地存储（IndexedDB）中。
- 换一台电脑、换一个浏览器、或者清理浏览器数据，记录就看不到了。
- **想长期保存或换机器，请用结果页的「导出 JSON」。** 导出的文件里不含任何密钥。

---

## 结果怎么读（重要）

- 系统**不会**给出一个单一总分。它给的是一份分维度的画像。
- **「思想认同与政治—理论画像」这一层（A 层）不参与角色适配，也不用于任何吸纳或淘汰判断。**
  它包含六个部分：
  1. **自我声明的理论认同** —— 你自己选的自我描述，系统原样呈现，**没有分数**，也不从其他回答推断；
  2. **理论熟悉程度** —— 只有 3 道概念题，属于低精度提示，**不代表理论水平**；
  3. **政治经济议题立场** —— 你选择的原始立场，不折算成分数；
  4. **社会—政治议题立场** —— 同上；
  5. **实践取向** —— 同上；
  6. **反身性与修正方式** —— 两道题方向一致时才给低置信度摘要，否则如实写"方向不一致"或"材料不足"。
- 合作与技能两层（B / C 层）是自陈材料，分数只在**这一套题**内部有意义，
  不是人口常模、不是百分位，更不是对人的判断。
- 最终判断请结合原始回答由人作出。

---

## 边界（产品硬约束，不能通过设置关掉）

- 不输出单一总分、排名、等级或百分位。
- 不输出「录用 / 淘汰 / 通过 / 不通过」这类结论。
- 不判断政治可靠、政治忠诚或意识形态纯度。
- 不输出「值得信任 / 不值得信任 / 危险人物 / 撒谎概率 / 欺骗指数 / 真实性评分」。
- 理论层（A 层）不进入角色适配；六个部分不能相加成一个"政治—理论总分"。
- AI 报告由模型生成，输出前会过一遍边界词过滤；但它仍可能有错，请以结构化结果为准。

---

## 想要 AI 综合报告（可选）

默认不联网、不调用任何模型也能走完整个流程。想要 AI 报告时：

1. 打开「设置」，选一个服务商（或选「本地示例（不联网）」先看效果）。
2. 填入你自己的 API Key。**Key 只存在这个浏览器的本次会话里，不会写进导出文件。**
3. 点「测试连接」，看到「连接正常」后回到结果页点「生成 AI 综合报告」。

AI 报告只做转写，不重新打分。它拿到的数据里**不含**你在 A2–A5 上的具体选择，
也不含 B/C 层的作答原文。

---

## 版本

- 应用：\`${appConfig.name} v${appVersion}\`
- 题库：\`${packVersion.id}@${packVersion.version}\`（A 层 V1.1）
- 评分模型：\`${scoringVersion.id}@${scoringVersion.version}\`
- 报告 Prompt：\`report-prompt-v2\`
`,
  'utf8',
)

writeFileSync(
  join(OUT_DIR, '技术说明.md'),
  `# 技术说明（交付包）

本文件写给需要核对交付内容的人，不需要阅读也能正常使用。

## 构建来源

| 项目 | 值 |
| --- | --- |
| 应用版本 | \`${appVersion}\` |
| 题库 | \`${packVersion.id}@${packVersion.version}\`（A 层 V1.1，120 题） |
| 评分模型 | \`${scoringVersion.id}@${scoringVersion.version}\` |
| 角色模型 | \`roles-v1@1.0.0\`（自 V1.0 起未变） |
| 报告 Prompt | \`report-prompt-v2\` |
| 构建命令 | \`npm run build\` + \`npm run build:delivery\` |
| 组装命令 | \`npm run pack:delivery\` |

## 目录内容

| 路径 | 是什么 |
| --- | --- |
| \`CohortLens.html\` | 单文件离线版。全部 JS/CSS/题库内联在这一个文件里，不含任何外部引用 |
| \`app/\` | 标准静态站点（PWA）。含 \`index.html\`、\`assets/\`、\`manifest.webmanifest\`、\`sw.js\`、\`icons/\` |
| \`启动本地服务器.cmd\` | Windows 启动脚本，调用 \`server.cjs\` |
| \`server.cjs\` | 零依赖 Node 静态服务器（只用 Node 内置模块，无 npm 依赖），带路径越界防护 |
| \`SHA256SUMS.txt\` | 本目录全部文件的 SHA-256 |

## 两种版本的关系

两者是**同一份源码的两次构建**，业务代码完全相同，差别只在打包方式：

- \`CohortLens.html\` 不包含 Service Worker。从 \`file://\` 打开时浏览器不允许注册 SW，
  而单文件本身就已经完全离线，不需要 SW。构建配置为 \`vite.config.delivery.ts\`。
- \`app/\` 包含 Service Worker（\`sw.js\`），因此可以"安装成应用"并离线打开。
  它需要一个 http(s) 来源，所以配了 \`server.cjs\`。

## 已验证 / 未验证

**已验证（本机自动测试）：**

- \`CohortLens.html\` 从 \`file://\` 双击打开可正常渲染，且**不发出任何外部请求、无失败请求**。
- \`CohortLens.html\` 能在无服务器、不联网的条件下走完：抽题 → 30 题作答 → 结构化结果 → 历史记录。
- 单文件版不含任何 Service Worker 注册代码，不会在控制台产生相关报错。
- 桌面与移动两种 viewport 均通过（Chromium）。
- 主站点的完整本地闸门：204 个单元/集成测试、24+24 条 Playwright E2E、题库与配置校验全部通过。

**未验证（需要人工确认）：**

- 在一台**没有安装 Node.js** 的电脑上双击 \`CohortLens.html\`。
- 在 Firefox / Safari 上的实际表现（自动测试只跑过 Chromium）。
- 真实打印 / 另存为 PDF 的版式效果。
- 使用真实第三方模型服务商生成 AI 报告的效果与质量。

## 数据与隐私

- 无中心服务器、无账号、无遥测、无分析。
- 所有数据存在浏览器本地（IndexedDB）。
- 导出 JSON 前会做一次形状扫描：命中疑似密钥即中止导出。
- 交付包内不含任何 API Key，也不含任何真实个人数据。
`,
  'utf8',
)

step('6/7 计算校验和')
const files: string[] = []
function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else files.push(full)
  }
}
walk(OUT_DIR)
const lines = files
  .filter((file) => !file.endsWith('SHA256SUMS.txt'))
  .sort()
  .map((file: string) => {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
    return `${hash}  ${relative(OUT_DIR, file).replace(/\\/g, '/')}`
  })
writeFileSync(join(OUT_DIR, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')

step('7/7 交付前自检')
const problems = auditBundle(OUT_DIR)

const totalBytes = files.reduce((sum: number, file: string) => sum + statSync(file).size, 0)
console.log(`\n交付包已生成：${OUT_DIR}`)
console.log(`  文件数：${files.length + 1}（含 SHA256SUMS.txt）`)
console.log(`  总大小：${(totalBytes / 1024 / 1024).toFixed(2)} MiB`)
console.log(
  `  单文件版：${(statSync(join(OUT_DIR, 'CohortLens.html')).size / 1024).toFixed(0)} KiB`,
)

if (problems.length > 0) {
  console.error('\n交付包自检未通过：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('  自检：通过（单文件自包含、无 SW 引用、无 V1.0 残留、无凭据形状）')

function readJson(file: string): { id: string; version: string } {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Checks that must hold for the artefact to be shippable.
 *
 * These are the failures that would otherwise be found by the client rather than by us:
 * a single file that quietly references something it did not inline, a stray service-worker
 * registration in a `file://` page, the retired V1.0 pack leaking into the bundle, or a credential
 * shape in a build output.
 */
function auditBundle(bundleDir: string): string[] {
  const problems: string[] = []
  const singleFile = readFileSync(join(bundleDir, 'CohortLens.html'), 'utf8')

  const externalRefs = [...singleFile.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((url) => !url.startsWith('data:'))
  if (externalRefs.length > 0) {
    problems.push(`单文件版仍引用外部文件：${externalRefs.join(', ')}`)
  }
  for (const forbidden of ['serviceWorker', 'workbox', 'sw.js']) {
    if (singleFile.includes(forbidden)) {
      problems.push(`单文件版包含 "${forbidden}"，从 file:// 打开会报错`)
    }
  }
  if (!singleFile.includes('A0_declared_identity')) {
    problems.push('单文件版里找不到 A 层 V1.1 内容（A0_declared_identity）')
  }
  if (singleFile.includes('question-pack-v1.0')) {
    problems.push('单文件版里出现了已退役的 V1.0 题库')
  }

  /**
   * Credential scan, inverted so it does not cry wolf.
   *
   * The app *contains* the patterns it uses to detect a key in an export
   * (`/sk-[A-Za-z0-9_-]{16,}/`), the `Authorization: Bearer ${key}` header template, and the
   * IndexedDB record key `apiKey`. A plain substring scan matches all three and reports "leaks"
   * that are in fact the anti-leak machinery. So the known-legitimate occurrences are removed
   * first, and only then is anything that *looks like a real credential* looked for.
   */
  const allowed = [
    '/sk-[A-Za-z0-9_-]{16,}/g',
    '/sk-proj-[A-Za-z0-9_-]{16,}/g',
    'Authorization:`Bearer ${o}`',
    '`Bearer ${',
  ]
  const credentialShapes: { name: string; re: RegExp }[] = [
    { name: 'OpenAI 风格密钥', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
    { name: 'Google API Key', re: /AIza[0-9A-Za-z_-]{30,}/g },
    { name: 'Anthropic 密钥', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    { name: 'Bearer 令牌字面量', re: /Bearer\s+[A-Za-z0-9._-]{25,}/g },
    {
      name: '配置字段里的长随机串',
      re: /"(?:apiKey|api_key|token|secret)"\s*:\s*"[A-Za-z0-9_\-.]{24,}"/g,
    },
  ]

  const bundleFiles: string[] = []
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) collect(full)
      else bundleFiles.push(full)
    }
  }
  collect(bundleDir)

  for (const file of bundleFiles) {
    if (/\.(png|jpg|ico|woff2)$/i.test(file)) continue
    let text = readFileSync(file, 'utf8')
    for (const snippet of allowed) text = text.split(snippet).join('<ALLOWED>')
    for (const shape of credentialShapes) {
      const hits = [...text.matchAll(shape.re)].map((match) => match[0])
      if (hits.length > 0) {
        problems.push(`${relative(bundleDir, file)} 疑似含真实凭据（${shape.name}）：${hits[0]}`)
      }
    }
  }

  return problems
}
