import { Link } from 'react-router-dom'
import type { ReportRecord } from '../../infrastructure/storage/report-repository.ts'
import { formatDateTime } from '../../utils/format.ts'
import { renderMarkdownBlocks } from './markdown.tsx'

/**
 * AI report panel — Engineering Bible §24, §62, and the Local MVP brief §19/§20.
 *
 * Two rules are enforced visually here:
 *   1. A failure never hides or degrades the base result. The panel shows the exact wording §62
 *      requires ("基础测评已经完成。AI 综合报告暂时无法生成。") and the rest of the page stays.
 *   2. A report is never presented as more than a transcription of the structured result. The
 *      header says so, and a mock report is labelled as a local sample.
 */

export interface ReportPanelProps {
  report: ReportRecord | null
  status: 'idle' | 'generating' | 'ready' | 'failed'
  error: string | null
  isMock: boolean
  keyConfigured: boolean
  offline: boolean
  onToggleOffline: () => void
  onGenerate: () => void
}

export function ReportPanel({
  report,
  status,
  error,
  isMock,
  keyConfigured,
  offline,
  onToggleOffline,
  onGenerate,
}: ReportPanelProps) {
  const generating = status === 'generating'
  const disabled = generating || offline

  return (
    <section className="card" data-testid="report-panel">
      <h2>AI 综合报告（可选）</h2>
      <p className="hint">
        报告由你自己配置的模型把上面这份结构化结果转写成自然语言，不重新打分、不新增证据。不开这一步，上面的结果依然完整可用。
      </p>

      <div className="report-status-row">
        <span className={offline ? 'tag tag-warn' : 'tag tag-active'} data-testid="network-state">
          {offline ? '离线模式' : '在线'}
        </span>
        <button
          type="button"
          className="button small"
          onClick={onToggleOffline}
          data-testid="toggle-offline"
        >
          切换为{offline ? '在线' : '离线'}（用于验证离线边界）
        </button>
      </div>

      {offline && (
        <p className="hint" data-testid="offline-note">
          联网后可生成 AI 综合报告。离线状态下，读取历史、继续测评、本地评分与导出都不受影响。
        </p>
      )}

      {report && (
        <div className="report-body" data-testid="report-body">
          <p className="report-meta">
            生成于 {formatDateTime(report.createdAt)} · 模型 {report.provider.model || '(未记录)'} ·
            用时 {(report.durationMs / 1000).toFixed(1)}s
            {report.isMock ? ' · 本地示例，未调用真实模型' : ''}
          </p>
          {report.sanitizedViolations && report.sanitizedViolations.length > 0 && (
            <p className="hint" data-testid="report-sanitized">
              报告中有 {report.sanitizedViolations.length} 处用语触碰了产品边界，已被自动屏蔽。
              {/*
                The masked phrases are deliberately NOT listed here. Printing them in order to
                explain that they were removed puts them straight back on screen, which is the
                opposite of what the filter is for. The exact phrases stay in the stored record for
                diagnostics and are never rendered.
              */}
            </p>
          )}
          {renderMarkdownBlocks(report.content)}
        </div>
      )}

      {!report && !error && !generating && (
        <p className="hint">
          {keyConfigured
            ? '还没有生成报告。点下面的按钮即可。'
            : '还没有配置 API Key。可以先用「本地示例（不联网）」跑通整条链路，再到设置页填自己的 Key。'}
        </p>
      )}

      {error && (
        <div className="banner banner-warn" role="status" data-testid="report-error">
          <strong>基础测评已经完成。AI 综合报告暂时无法生成。</strong>
          <span className="banner-detail">{error}</span>
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className="button primary"
          onClick={onGenerate}
          disabled={disabled}
          data-testid="generate-report"
        >
          {generating ? '正在生成…' : report ? '重新生成 AI 综合报告' : '生成 AI 综合报告'}
        </button>
        <Link className="button" to="/settings">
          AI 报告设置
        </Link>
      </div>

      {isMock && report && (
        <p className="hint">
          这份报告来自内置的本地示例 Provider，用于验证链路，不是任何真实模型的输出。
        </p>
      )}
    </section>
  )
}
