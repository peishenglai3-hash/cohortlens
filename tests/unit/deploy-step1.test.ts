import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyDatabaseId,
  parseCreatedDatabaseId,
  parseDatabaseIdByName,
} from '../../scripts/deploy-step1-lib.ts'

/**
 * 部署第 1 步的测试。
 *
 * 为什么给一个部署脚本写测试：它是整条部署链路上**唯一会修改文件**的一步，而它解析的是另一个
 * 程序（wrangler）的人类可读输出。解析错了只有两种结局——崩溃，或者把错误的 database_id 写进
 * 一个随后会被部署的配置文件里。后者会在几分钟后以一种完全指不到这里的方式失败，所以宁可在这里
 * 花二十行测它。
 *
 * 这些测试**不联网、不调用 wrangler**：解析函数是纯函数，输入是真实 wrangler 输出的样本。
 */

// Vitest runs with the project root as cwd, and `import.meta.url` is not a file: URL under its
// transform, so the path is resolved from cwd rather than from the module URL.
const repoRoot = resolve(process.cwd())

describe('parseCreatedDatabaseId —— 从 `wrangler d1 create` 输出里取 id', () => {
  it('reads the id out of the real output shape', () => {
    const output = `
 ⛅️ wrangler 4.149.0
────────────────────

 🎉 Successfully created DB 'cohortlens-reviews' in region WEUR
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "cohortlens-reviews"
database_id = "1234abcd-5678-90ef-1234-567890abcdef"
`
    expect(parseCreatedDatabaseId(output)).toBe('1234abcd-5678-90ef-1234-567890abcdef')
  })

  it('returns null when the database already exists and there is no id in the output', () => {
    const output = `✘ [ERROR] A database with the name 'cohortlens-reviews' already exists`
    expect(parseCreatedDatabaseId(output)).toBeNull()
  })

  it('does not mistake an unrelated id for the database id', () => {
    const output = `account_id = "99999999-9999-9999-9999-999999999999"`
    expect(parseCreatedDatabaseId(output)).toBeNull()
  })
})

describe('parseDatabaseIdByName —— 从 `wrangler d1 list` 输出里按名字取 id', () => {
  it('pairs the uuid that precedes the name in the same object', () => {
    const output = JSON.stringify(
      [
        { uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'some-other-db', created_at: 'x' },
        {
          uuid: 'bbbbbbbb-1111-2222-3333-444444444444',
          name: 'cohortlens-reviews',
          created_at: 'y',
        },
      ],
      null,
      2,
    )
    expect(parseDatabaseIdByName(output, 'cohortlens-reviews')).toBe(
      'bbbbbbbb-1111-2222-3333-444444444444',
    )
  })

  it('also handles name-first key ordering', () => {
    const output = JSON.stringify(
      [{ name: 'cohortlens-reviews', uuid: 'cccccccc-1111-2222-3333-444444444444' }],
      null,
      2,
    )
    expect(parseDatabaseIdByName(output, 'cohortlens-reviews')).toBe(
      'cccccccc-1111-2222-3333-444444444444',
    )
  })

  it('reads the ASCII table wrangler actually prints when not attached to a terminal', () => {
    // Copied verbatim from a real `wrangler d1 list` run — the JSON-only parser missed this and
    // reported "找不到 database_id" against a database that existed.
    const output = [
      '⛅️ wrangler 4.149.0',
      '────────────────────',
      '┌──────────────────────────────────────┬────────────────────┬──────────────────────────┬────────────┬────────────┬───────────┬──────────────┐',
      '│ uuid                                 │ name               │ created_at               │ version    │ num_tables │ file_size │ jurisdiction │',
      '├──────────────────────────────────────┼────────────────────┼──────────────────────────┼────────────┼────────────┼───────────┼──────────────┤',
      '│ ed0a3b50-33c1-4e01-b7a1-7e69c2de471e │ cohortlens-reviews │ 2026-10-09T14:00:04.781Z │ production │ 0          │ 8192      │              │',
      '└──────────────────────────────────────┴────────────────────┴──────────────────────────┴────────────┴────────────┴───────────┴──────────────┘',
    ].join('\n')
    expect(parseDatabaseIdByName(output, 'cohortlens-reviews')).toBe(
      'ed0a3b50-33c1-4e01-b7a1-7e69c2de471e',
    )
  })

  it('does not return another row\u2019s id from the same table', () => {
    const output = [
      '│ uuid                                 │ name                 │',
      '│ aaaaaaaa-1111-2222-3333-444444444444 │ some-other-database  │',
      '│ bbbbbbbb-1111-2222-3333-444444444444 │ cohortlens-reviews   │',
    ].join('\n')
    expect(parseDatabaseIdByName(output, 'cohortlens-reviews')).toBe(
      'bbbbbbbb-1111-2222-3333-444444444444',
    )
    expect(parseDatabaseIdByName(output, 'not-in-the-list')).toBeNull()
  })

  it('returns null rather than somebody else\u2019s database when the name is absent', () => {
    // The failure this guards against is silent and destructive: picking the first uuid in the file
    // would point the deployment at an unrelated database.
    const output = JSON.stringify(
      [{ uuid: 'dddddddd-1111-2222-3333-444444444444', name: 'unrelated-db' }],
      null,
      2,
    )
    expect(parseDatabaseIdByName(output, 'cohortlens-reviews')).toBeNull()
  })
})

describe('applyDatabaseId —— 改写 wrangler.toml', () => {
  const realToml = readFileSync(resolve(repoRoot, 'wrangler.toml'), 'utf8')
  const id = '01234567-89ab-cdef-0123-456789abcdef'

  /**
   * The shipped file is exercised twice, because it has two legitimate states and both must work:
   *
   *   - a **fresh clone** still has the commented-out block (branch `activated`), and
   *   - a machine that has already run step 1 has a real id in place (branch `replaced`).
   *
   * The synthetic block below stands in for the fresh-clone case so this test does not depend on the
   * state of the developer's working copy — a test that changes meaning once you run the tool it
   * tests is a test that will eventually lie.
   */
  const freshCloneToml = [
    'name = "cohortlens-review"',
    'main = "worker/index.ts"',
    '',
    '[vars]',
    'ALLOWED_ORIGINS = "http://localhost:5173"',
    '',
    '# 取消下面这段的注释并填入真实 database_id。占位符故意保持注释状态：',
    '# 一个填错的 id 会让 wrangler 部署失败并给出晦涩的错误，而"没配"至少是明确的。',
    '#',
    '# [[d1_databases]]',
    '# binding = "DB"',
    '# database_name = "cohortlens-reviews"',
    '# database_id = "<把 wrangler d1 create 输出的 id 填在这里>"',
    '',
  ].join('\n')

  it('activates the commented-out block on a fresh clone', () => {
    const { toml, branch } = applyDatabaseId(freshCloneToml, id)
    expect(branch).toBe('activated')
    expect(toml).toMatch(/^\[\[d1_databases\]\]$/m)
    expect(toml).toMatch(/^binding = "DB"$/m)
    expect(toml).toMatch(/^database_name = "cohortlens-reviews"$/m)
    expect(toml).toMatch(new RegExp(`^database_id = "${id}"$`, 'm'))
    // The explanatory comment may stay; what must not stay is a commented-out *setting*, because a
    // reader (and TOML) would then see a binding that is not actually there.
    const activeBlock = toml.slice(toml.indexOf('[[d1_databases]]'))
    expect(activeBlock).not.toMatch(/^#\s*binding/m)
    expect(activeBlock).not.toMatch(/^#\s*database_name/m)
    expect(activeBlock).not.toMatch(/^#\s*database_id/m)
  })

  it('handles the real wrangler.toml in whatever state it is in', () => {
    // Either branch is correct here; what matters is that the id ends up active and the rest of the
    // file survives. Pinning a specific branch would make this test fail every time someone runs
    // step 1, which is exactly when it is most needed.
    const { toml, branch } = applyDatabaseId(realToml, id)
    expect(['activated', 'replaced']).toContain(branch)
    expect(toml).toMatch(new RegExp(`^database_id = "${id}"$`, 'm'))
    expect(toml).toMatch(/^binding = "DB"$/m)
  })

  it('leaves a genuine TOML that wrangler can read', () => {
    const { toml } = applyDatabaseId(realToml, id)
    // A commented binding left inside an active block would parse as a comment and silently drop the
    // binding, so the assertion is "no leftover commented binding lines in the active block".
    const activeBlock = toml.slice(toml.indexOf('[[d1_databases]]'))
    expect(activeBlock).not.toMatch(/^#\s*binding/m)
    expect(activeBlock).not.toMatch(/^#\s*database_name/m)
    expect(activeBlock).not.toMatch(/^#\s*database_id/m)
  })

  it('does not disturb the hand-edited variables', () => {
    const { toml } = applyDatabaseId(realToml, id)
    const before = realToml.match(/^ALLOWED_ORIGINS.*$/m)?.[0]
    const after = toml.match(/^ALLOWED_ORIGINS.*$/m)?.[0]
    expect(after).toBe(before)
    expect(after).toBeTruthy()
  })

  it('replaces a placeholder id in an already-active block', () => {
    const active = realToml
      .replace('# [[d1_databases]]', '[[d1_databases]]')
      .replace('# binding = "DB"', 'binding = "DB"')
      .replace('# database_name = "cohortlens-reviews"', 'database_name = "cohortlens-reviews"')
      .replace(
        '# database_id = "<把 wrangler d1 create 输出的 id 填在这里>"',
        'database_id = "old-id"',
      )
    const { toml, branch } = applyDatabaseId(active, id)
    expect(branch).toBe('replaced')
    expect(toml).toMatch(new RegExp(`^database_id = "${id}"$`, 'm'))
    expect(toml).not.toContain('old-id')
  })

  it('appends a block when neither shape is present', () => {
    const bare = 'name = "cohortlens-review"\nmain = "worker/index.ts"\n'
    const { toml, branch } = applyDatabaseId(bare, id)
    expect(branch).toBe('appended')
    expect(toml).toContain('[[d1_databases]]')
    expect(toml).toMatch(new RegExp(`database_id = "${id}"`))
    // The original content must survive.
    expect(toml.startsWith(bare)).toBe(true)
  })

  it('is idempotent: applying the same id twice changes nothing the second time', () => {
    const once = applyDatabaseId(realToml, id).toml
    const twice = applyDatabaseId(once, id)
    expect(twice.branch).toBe('replaced')
    expect(twice.toml).toBe(once)
  })
})
