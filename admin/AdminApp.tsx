import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  REVIEW_DECISION_LABELS,
  type ReviewDecisionLabel,
  type ReviewSummary,
} from '../src/domain/submission.ts'

/**
 * CohortLens 审阅台。
 *
 * 这个界面的**唯一职责**是：让审阅人尽快、尽可能准确地理解每位作答者交上来的材料，然后由他
 * 自己下判断。它刻意不提供任何"系统建议""综合排名""是否推荐"的位置——不是没做完，是设计上
 * 不允许（`RESULT_BOUNDARY_NOTICE`、A 层 `useForAdmissionDecision: false`，以及
 * `ReviewSummary` 里根本没有这类字段）。
 *
 * 三处界面决定值得说明：
 *
 *   1. **材料充分度放在最显眼处。** 审阅人最容易犯的错是拿一份只答了 60% 的材料去和答满的比。
 *      把完成度、薄维度、一致性提示摆在结论按钮之前，是让这个错误不容易发生。
 *   2. **结论标签是"工作记录"而不是"判决"。** 四个标签都用审阅人自己的动作措辞
 *      （待定 / 进一步了解 / 材料不足 / 本轮不合适），没有一个说"这个人不合格"。
 *   3. **原始材料始终可展开。** 摘要会丢信息，而"最终判断由人结合原始回答作出"是产品的承诺，
 *      所以完整正文必须一键可达，且默认折叠以免喧宾夺主。
 */

const TOKEN_KEY = 'cohortlens.admin.token'

interface ListItem {
  id: string
  receivedAt: string
  inviteLabel: string
  contactKind: string
  contactValue: string
  decisionLabel: string | null
  /**
   * Normally present. It is nullable because the server will not invent a summary: if a row was
   * written by an older build and could not be rebuilt, the honest answer is "unknown", and the row
   * says so rather than rendering as if the respondent had submitted nothing.
   */
  summary: ReviewSummary | null
  summaryError?: string | null
}

const DECISION_TEXT: Record<ReviewDecisionLabel, string> = {
  undecided: '待定',
  shortlisted: '想进一步了解',
  needs_more_info: '材料不足，需要补充',
  not_this_round: '本轮不合适',
}

function formatTime(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function DecisionBadge({ label }: { label: string | null }) {
  const key = (label ?? 'undecided') as ReviewDecisionLabel
  return <span className={`badge badge-${key}`}>{DECISION_TEXT[key] ?? label}</span>
}

export function AdminApp() {
  const [token, setToken] = useState(() => {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [tokenDraft, setTokenDraft] = useState('')
  const [items, setItems] = useState<ListItem[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [decisionFilter, setDecisionFilter] = useState('all')
  const [selected, setSelected] = useState<string | null>(null)

  const endpoint = useMemo(() => window.location.origin, [])

  const load = useCallback(
    async (activeToken: string, filter: string) => {
      setStatus('loading')
      setError(null)
      try {
        const query = new URLSearchParams({ limit: '50' })
        if (filter !== 'all') query.set('decision', filter)
        const response = await fetch(`${endpoint}/api/review/list?${query.toString()}`, {
          headers: { Authorization: `Bearer ${activeToken}` },
        })
        const body = (await response.json()) as {
          ok?: boolean
          total?: number
          items?: ListItem[]
          message?: string
          code?: string
        }
        if (!response.ok || !body.ok) {
          setStatus('error')
          setError(body.message ?? `请求失败（HTTP ${response.status}）`)
          if (response.status === 401) {
            try {
              window.sessionStorage.removeItem(TOKEN_KEY)
            } catch {
              /* ignore */
            }
            setToken('')
          }
          return
        }
        setItems(body.items ?? [])
        setTotal(body.total ?? 0)
        setStatus('ready')
      } catch (caught) {
        setStatus('error')
        setError(
          caught instanceof Error
            ? `无法连接审阅台：${caught.message}`
            : '无法连接审阅台，请检查网络。',
        )
      }
    },
    [endpoint],
  )

  useEffect(() => {
    if (token) void load(token, decisionFilter)
  }, [token, decisionFilter, load])

  if (!token) {
    return (
      <div className="shell">
        <div className="topbar">
          <h1>CohortLens 审阅台</h1>
        </div>
        <div className="card">
          <h2>需要审阅口令</h2>
          <p className="hint">
            口令由部署者在 Cloudflare Worker 上设置（`wrangler secret put ADMIN_TOKEN`）。
            它只保存在这个标签页的会话存储里，关闭标签页即失效。
          </p>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault()
              const value = tokenDraft.trim()
              if (!value) return
              try {
                window.sessionStorage.setItem(TOKEN_KEY, value)
              } catch {
                /* session-only fallback still works via state */
              }
              setToken(value)
              setTokenDraft('')
            }}
          >
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="token">审阅口令</label>
              <input
                id="token"
                type="password"
                autoComplete="off"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
              />
            </div>
            <button type="submit">进入审阅台</button>
          </form>
        </div>
      </div>
    )
  }

  const selectedItem = items.find((item) => item.id === selected) ?? null

  return (
    <div className="shell">
      <div className="topbar">
        <h1>CohortLens 审阅台</h1>
        <div className="row">
          <span className="hint">共 {total} 份材料 · 口令仅存于本标签页</span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              try {
                window.sessionStorage.removeItem(TOKEN_KEY)
              } catch {
                /* ignore */
              }
              setToken('')
              setItems([])
            }}
          >
            退出口令
          </button>
        </div>
      </div>

      <div className="card boundary">
        <b>这份工具不替你做判断。</b>
        下面每一份材料都只描述"在这次问卷里，这些回答呈现出什么"。没有综合分，没有推荐结论，
        也没有"通过/不通过"。请你结合原始回答自行判断。
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <div className="row">
          <div className="field">
            <label htmlFor="filter">只看</label>
            <select
              id="filter"
              value={decisionFilter}
              onChange={(event) => setDecisionFilter(event.target.value)}
            >
              <option value="all">全部材料</option>
              <option value="undecided">还没看过</option>
              {REVIEW_DECISION_LABELS.filter((label) => label !== 'undecided').map((label) => (
                <option key={label} value={label}>
                  {DECISION_TEXT[label]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => void load(token, decisionFilter)}
          >
            刷新
          </button>
        </div>
      </div>

      {status === 'loading' && <div className="card">正在读取…</div>}

      {status === 'ready' && items.length === 0 && (
        <div className="card">
          还没有收到任何材料。把这个链接发给作答者时记得带上邀请码：
          <div className="mono" style={{ marginTop: 8 }}>
            {window.location.origin.replace('cohortlens-review', 'your-respondent-app')}
            /#/assessment?invite=你的邀请码
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>收到时间</th>
                <th>联系方式</th>
                <th>批次</th>
                <th>材料完成度</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} title={item.summaryError ?? undefined}>
                  <td>{formatTime(item.receivedAt)}</td>
                  <td className="mono">
                    {item.contactKind === 'email' ? '✉' : '☎'} {item.contactValue}
                  </td>
                  <td>{item.summary?.inviteLabel || item.inviteLabel || '—'}</td>
                  <td>
                    {item.summary ? (
                      <>
                        {item.summary.material.answeredItems}/{item.summary.material.totalItems}
                        <div className="meter">
                          <div
                            style={{ width: `${item.summary.material.completionRatio * 100}%` }}
                          />
                        </div>
                      </>
                    ) : (
                      <span className="hint">该行摘要无法读取</span>
                    )}
                  </td>
                  <td>
                    <DecisionBadge label={item.decisionLabel} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setSelected(item.id === selected ? null : item.id)}
                    >
                      {item.id === selected ? '收起' : '查看材料'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedItem && (
        <SubmissionDetail
          key={selectedItem.id}
          item={selectedItem}
          token={token}
          endpoint={endpoint}
          onSaved={() => void load(token, decisionFilter)}
        />
      )}
    </div>
  )
}

function SubmissionDetail({
  item,
  token,
  endpoint,
  onSaved,
}: {
  item: ListItem
  token: string
  endpoint: string
  onSaved: () => void
}) {
  /**
   * The detail view fetches its own copy rather than reading `item.summary`.
   *
   * Two reasons. First, the list may legitimately carry `summary: null` (a row from an older build
   * the server could not rebuild), and the detail view is where that gets resolved — reading the
   * list's copy would throw on exactly the rows that need repair. Second, this request also returns
   * the full raw material, so one fetch now serves both the summary and the "expand raw JSON"
   * panel instead of two.
   */
  const [summary, setSummary] = useState<ReviewSummary | null>(item.summary)
  const [core, setCore] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(item.summary === null)
  const [label, setLabel] = useState<ReviewDecisionLabel>(
    (item.decisionLabel as ReviewDecisionLabel | null) ?? 'undecided',
  )
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [rawOpen, setRawOpen] = useState(false)

  const loadDetail = async () => {
    setLoadingDetail(true)
    setSaveError(null)
    try {
      const response = await fetch(
        `${endpoint}/api/review/submission/${encodeURIComponent(item.id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const body = (await response.json()) as {
        ok?: boolean
        summary?: ReviewSummary
        core?: unknown
        message?: string
      }
      if (!response.ok || !body.ok || !body.summary) {
        setSaveError(body.message ?? '无法读取这份材料的详情。')
        return
      }
      setSummary(body.summary)
      setCore(JSON.stringify(body.core, null, 2))
      if (body.summary.decision) {
        setLabel(body.summary.decision.label)
        setReason(body.summary.decision.reason)
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '无法读取这份材料的详情。')
    } finally {
      setLoadingDetail(false)
    }
  }

  useEffect(() => {
    // Always refresh on open: this is also what repairs a stale summary server-side.
    void loadDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const response = await fetch(
        `${endpoint}/api/review/submission/${encodeURIComponent(item.id)}/decision`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ label, reason }),
        },
      )
      const body = (await response.json()) as { ok?: boolean; message?: string }
      if (!response.ok || !body.ok) {
        setSaveError(body.message ?? `保存失败（HTTP ${response.status}）`)
        return
      }
      onSaved()
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loadingDetail && !summary) {
    return (
      <div className="card">
        <h2>材料详情</h2>
        <p className="hint">正在读取…</p>
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="card">
        <h2>材料详情</h2>
        <div className="error" role="alert">
          {saveError ?? '这份材料的审阅摘要无法读取。'}
        </div>
      </div>
    )
  }

  const thin = summary.material.thinDimensions

  return (
    <div className="card">
      <h2>材料详情</h2>
      <p className="hint mono">
        {item.id} · 收到 {formatTime(summary.receivedAt)} · 作答于 {formatTime(summary.assessedAt)}
      </p>
      <p className="hint">
        题库 {summary.versions.questionPackId}@{summary.versions.questionPackVersion} · 评分{' '}
        {summary.versions.scoringVersion}
      </p>

      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="hint">材料完成度</div>
          <b>
            {summary.material.answeredItems} / {summary.material.totalItems} 题
          </b>
          <div className="meter">
            <div style={{ width: `${summary.material.completionRatio * 100}%` }} />
          </div>
        </div>
        <div className="stat">
          <div className="hint">回答一致性</div>
          <b>
            {summary.material.needsFurtherUnderstanding
              ? '有配对需要进一步了解'
              : '未见明显方向差异'}
          </b>
        </div>
        <div className="stat">
          <div className="hint">证据量低于预期的维度</div>
          <b>{thin.length === 0 ? '无' : thin.join('、')}</b>
          <div className="hint" style={{ marginTop: 4 }}>
            B / C 层每维本来就只有 1–2 题，那不算缺材料；这里只列"实际作答少于该维预期题量"的维度。
          </div>
        </div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary className="hint" style={{ cursor: 'pointer' }}>
          逐维证据量（实际 / 预期）
        </summary>
        <ul className="tight mono">
          {summary.material.coverage.map((entry) => (
            <li key={entry.dimension}>
              {entry.dimension}: {entry.answeredItems} / {entry.expectedItems}
              {entry.answeredItems < entry.expectedItems && ' ← 低于预期'}
            </li>
          ))}
        </ul>
      </details>

      <h3 style={{ marginTop: 20 }}>B / C 层维度画像</h3>
      <p className="hint">
        角色适配只使用 B / C 层。分数只在这一套题库内部有意义，不是常模、不是百分位。
      </p>
      <table>
        <thead>
          <tr>
            <th>维度</th>
            <th>归一化</th>
            <th>题量</th>
            <th>区间</th>
          </tr>
        </thead>
        <tbody>
          {summary.dimensions
            .filter((dimension) => dimension.layer !== 'theory_value')
            .map((dimension) => (
              <tr key={dimension.id}>
                <td>{dimension.label}</td>
                <td>
                  {dimension.normalizedScore}
                  <div className="meter">
                    <div style={{ width: `${dimension.normalizedScore}%` }} />
                  </div>
                </td>
                <td>{dimension.answeredItems}</td>
                <td>{dimension.band}</td>
              </tr>
            ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 20 }}>角色适配</h3>
      <table>
        <thead>
          <tr>
            <th>角色</th>
            <th>匹配</th>
            <th>权重覆盖率</th>
            <th>参与维度</th>
          </tr>
        </thead>
        <tbody>
          {summary.roleFits.map((fit) => (
            <tr key={fit.roleId}>
              <td>{fit.name}</td>
              <td>{fit.fitScore}</td>
              <td>{Math.round(fit.coverage * 100)}%</td>
              <td className="mono">{fit.contributingDimensions.join(', ') || '（无）'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 20 }}>A 层 · 思想认同与政治—理论画像</h3>
      {summary.aLayer ? (
        <>
          <div className="notice">
            {(summary.aLayer.boundaries.length > 0
              ? summary.aLayer.boundaries
              : ['A 层为自愿自报材料，不参与角色适配。']
            ).map((boundary) => (
              <div key={boundary}>· {boundary}</div>
            ))}
          </div>

          <h4>自我声明的理论认同（A0，直接自报）</h4>
          <ul className="tight">
            {summary.aLayer.declaredIdentity.map((entry) => (
              <li key={`${entry.topic}-${entry.selectedCategory}`}>
                <b>{entry.topic}</b> — {entry.selectedText}
                <span className="hint mono"> （{entry.selectedCategory}）</span>
              </li>
            ))}
            {summary.aLayer.declaredIdentity.length === 0 && <li className="hint">（未作答）</li>}
          </ul>

          <h4>理论熟悉度（A1）</h4>
          {summary.aLayer.theoryFamiliarity ? (
            <p>
              答对 {summary.aLayer.theoryFamiliarity.correct} /{' '}
              {summary.aLayer.theoryFamiliarity.answered} 题
              {summary.aLayer.theoryFamiliarity.lowSample && (
                <span className="hint"> · 低精度提示（题量极少，不代表理论水平）</span>
              )}
            </p>
          ) : (
            <p className="hint">（未抽到该部分）</p>
          )}

          <h4>议题立场与实践取向（A2–A4，原始材料，不折算分数）</h4>
          <ul className="tight">
            {summary.aLayer.issuePositions.map((entry) => (
              <li key={`${entry.dimension}-${entry.topic}`}>
                <span className="hint">{entry.dimension}</span> · <b>{entry.topic}</b> —{' '}
                {entry.selectedText}
              </li>
            ))}
          </ul>

          <h4>反身性（A5）</h4>
          <p>
            {summary.aLayer.reflexivity.state === 'aligned'
              ? '两道题方向一致'
              : summary.aLayer.reflexivity.state === 'mixed'
                ? '方向不一致（混合）'
                : '材料不足'}
          </p>
        </>
      ) : (
        <p className="hint">这份材料来自旧版题库，没有 A 层六部分画像。</p>
      )}

      <h3 style={{ marginTop: 20 }}>测评局限性（引擎自己写的）</h3>
      <ul className="tight">
        {summary.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>

      <h3 style={{ marginTop: 20 }}>你的判断</h3>
      <p className="hint">
        这一栏记录的是**你自己**的判断，不是系统的结论。写清理由，几周后你自己还能看懂当时为什么这么判。
      </p>
      <div className="row">
        <div className="field">
          <label htmlFor="decision">状态</label>
          <select
            id="decision"
            value={label}
            onChange={(event) => setLabel(event.target.value as ReviewDecisionLabel)}
          >
            {REVIEW_DECISION_LABELS.map((option) => (
              <option key={option} value={option}>
                {DECISION_TEXT[option]}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存判断'}
        </button>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor="reason">理由（可留空）</label>
        <textarea
          id="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：合作层的沟通与冲突处理证据充分，但材料只有 2 题支撑，想面谈确认。"
        />
      </div>
      {saveError && <div className="error">{saveError}</div>}

      <h3 style={{ marginTop: 20 }}>原始材料</h3>
      <p className="hint">
        摘要是压缩过的。上面任何一处让你犹豫，都应该回原始材料核对——最终判断由你作出。
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => setRawOpen((value) => !value)}
        disabled={!core}
      >
        {rawOpen ? '收起原始材料' : '展开原始材料（完整 JSON）'}
      </button>
      {rawOpen && core && <pre className="raw">{core}</pre>}
    </div>
  )
}
