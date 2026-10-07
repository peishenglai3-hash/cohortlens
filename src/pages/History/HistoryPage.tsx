import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppStore } from '../../app/store.ts'
import { formatDateTime } from '../../utils/format.ts'
import { getRepositories } from '../../infrastructure/storage/index.ts'
import {
  auditExport,
  buildExportBundle,
  downloadJson,
  exportFileName,
} from '../../infrastructure/export/json-export.ts'

/**
 * History page — Engineering Bible §37 and the Local MVP brief §8.
 *
 * Shows test date, status, question pack version and whether an AI report exists. Supports view,
 * resume an unfinished assessment, delete (with confirmation) and export.
 *
 * Deleting is confirmed with an explicit dialog rather than a silent click, because it removes
 * both the session and its result and report in one go.
 */
export function HistoryPage() {
  const history = useAppStore((state) => state.history)
  const resume = useAppStore((state) => state.resume)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const refreshHistory = useAppStore((state) => state.refreshHistory)
  const navigate = useNavigate()
  const [message, setMessage] = useState<string | null>(null)

  const handleOpen = async (sessionId: string, isCompleted: boolean) => {
    await resume(sessionId)
    navigate(isCompleted ? '/result' : '/assessment')
  }

  const handleExport = async (sessionId: string) => {
    const entry = history.find((candidate) => candidate.session.id === sessionId)
    if (!entry?.result) {
      setMessage('这次测评还没有结果，暂时不能导出。完成测评后即可导出。')
      return
    }
    const repos = await getRepositories()
    const report = await repos.reports.getByResult(entry.result.id)
    const bundle = buildExportBundle({
      session: entry.session,
      result: entry.result,
      report,
    })
    const audit = auditExport(bundle)
    if (!audit.clean) {
      setMessage(`导出已中止：检测到可疑内容（${audit.findings.join('；')}）。`)
      return
    }
    downloadJson(bundle, exportFileName(entry.session, bundle.exportedAt))
    setMessage(`已导出 ${entry.session.id}。文件中不含 API Key。`)
  }

  const handleDelete = async (sessionId: string) => {
    if (!window.confirm('删除这次测评会同时删除它的结果与 AI 报告，且无法恢复。确定删除吗？'))
      return
    await deleteSession(sessionId)
    setMessage('已删除。')
    await refreshHistory()
  }

  if (history.length === 0) {
    return (
      <main className="page">
        <h1>历史记录</h1>
        <p>本机还没有任何测评记录。测评记录只保存在这台设备上，不会上传。</p>
        <div className="actions">
          <Link className="button primary" to="/assessment">
            开始一次测评
          </Link>
        </div>
      </main>
    )
  }

  const unfinished = history.filter((entry) => entry.session.status === 'draft')

  return (
    <main className="page">
      <h1>历史记录</h1>
      <p className="subtitle">
        共 {history.length} 条记录，其中 {unfinished.length} 条未完成。全部保存在本机浏览器中。
      </p>

      {message && (
        <p className="hint" data-testid="history-message">
          {message}
        </p>
      )}

      <ul className="history-list">
        {history.map((entry) => {
          const isCompleted = entry.session.status === 'completed'
          return (
            <li
              className="card history-item"
              key={entry.session.id}
              data-testid={`history-${entry.session.id}`}
            >
              <div className="history-head">
                <span className="history-date" data-testid="history-date">
                  {formatDateTime(entry.session.createdAt)}
                </span>
                <span
                  className={isCompleted ? 'tag tag-active' : 'tag tag-warn'}
                  data-testid="history-status"
                >
                  {isCompleted ? '已完成' : '未完成'}
                </span>
                {entry.hasReport && (
                  <span className="tag tag-active" data-testid="history-has-report">
                    有 AI 报告
                  </span>
                )}
              </div>

              <dl className="meta-list">
                <div>
                  <dt>题库版本</dt>
                  <dd data-testid="history-pack-version">
                    {entry.session.questionPackId}@{entry.session.questionPackVersion}
                  </dd>
                </div>
                <div>
                  <dt>作答进度</dt>
                  <dd>
                    {entry.answered} / {entry.total} 题
                  </dd>
                </div>
                <div>
                  <dt>最近修改</dt>
                  <dd>{formatDateTime(entry.session.updatedAt)}</dd>
                </div>
                <div>
                  <dt>评分版本</dt>
                  <dd>
                    {entry.session.scoringVersion} · 角色模型 {entry.session.roleModelVersion}
                  </dd>
                </div>
              </dl>

              <div className="actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void handleOpen(entry.session.id, isCompleted)}
                  data-testid="history-open"
                >
                  {isCompleted ? '查看结果' : '继续这次测评'}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => void handleExport(entry.session.id)}
                  disabled={!entry.result}
                  data-testid="history-export"
                >
                  导出 JSON
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => void handleDelete(entry.session.id)}
                  data-testid="history-delete"
                >
                  删除
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="actions">
        <Link className="button" to="/">
          回首页
        </Link>
      </div>
    </main>
  )
}
