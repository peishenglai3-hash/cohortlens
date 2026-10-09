import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppStore } from '../../app/store.ts'
import { loadContentBundle } from '../../content/load-content.ts'
import { RESULT_BOUNDARY_NOTICE } from '../../config/product.ts'
import { LAYERS, type AssessmentResult, type Layer } from '../../domain/schemas.ts'
import { formatDateTime, formatPercent } from '../../utils/format.ts'
import { API_KEY_SESSION } from '../../infrastructure/ai/session-key.ts'
import { createProvider } from '../../infrastructure/ai/factory.ts'
import { generateReport, ReportGenerationError } from '../../infrastructure/ai/report-service.ts'
import { classifyError, STATUS_LABELS } from '../../infrastructure/ai/adapters/openai-compatible.ts'
import {
  auditExport,
  buildExportBundle,
  downloadJson,
  exportFileName,
} from '../../infrastructure/export/json-export.ts'
import { getRepositories } from '../../infrastructure/storage/index.ts'
import { ALayerSection } from './ALayerSection.tsx'
import { ReportPanel } from './ReportPanel.tsx'
import { SubmitPanel } from './SubmitPanel.tsx'

const LAYER_TITLES: Record<Layer, string> = {
  theory_value: 'A 层 · 理论与问题理解',
  cooperation_behavior: 'B 层 · 合作与行为',
  skill_role: 'C 层 · 技能与角色',
}

const LAYER_NOTES: Record<Layer, string> = {
  theory_value: '这一层不参与角色适配，也不得解释为政治立场、政治忠诚或意识形态纯度。',
  cooperation_behavior: '这一层是自陈材料，受社会赞许倾向影响，需要结合原始回答人工复核。',
  skill_role: '这一层是自陈的自我技能描述，不是能力测试结果。',
}

function ProfileBar({ score }: { score: number }) {
  return (
    <div className="profile-track" role="presentation">
      <div className="profile-fill" style={{ width: `${score}%` }} />
    </div>
  )
}

/**
 * Result screen — Engineering Bible §58, §59 and the Local MVP brief §7.
 *
 * Profile cards + progress bars + role cards + collapsible evidence. Nothing here recomputes a
 * score: the page renders the Structured Result the engine produced, verbatim. Deliberately absent:
 * leaderboards, red/green pass-fail, admissions wording, and any single total (§16, brief §7).
 */
export function ResultPage() {
  const session = useAppStore((state) => state.session)
  const result = useAppStore((state) => state.result)
  const report = useAppStore((state) => state.report)
  const reportStatus = useAppStore((state) => state.reportStatus)
  const reportError = useAppStore((state) => state.reportError)
  const settings = useAppStore((state) => state.settings)
  const setReport = useAppStore((state) => state.setReport)
  const setReportStatus = useAppStore((state) => state.setReportStatus)
  const saveSettings = useAppStore((state) => state.saveSettings)

  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && !navigator.onLine,
  )

  const { pack } = loadContentBundle()

  if (!result || !session) {
    return (
      <main className="page">
        <h1>还没有结果</h1>
        <p>请先完成一次测评，或在历史记录里打开一次已经完成的结果。</p>
        <div className="actions">
          <Link className="button primary" to="/assessment">
            去测评
          </Link>
          <Link className="button" to="/history">
            历史记录
          </Link>
        </div>
      </main>
    )
  }

  const questionById = new Map(pack.questions.map((question) => [question.id, question]))
  const optionText = (questionId: string, optionId: string): string => {
    const question = questionById.get(questionId)
    const option = question?.options.find((candidate) => candidate.id === optionId)
    return option?.text ?? '(未作答)'
  }
  const detail = (value: AssessmentResult): string =>
    value.dimensions
      .map((dimension) => `${dimension.label} ${dimension.normalizedScore}`)
      .join(' · ')

  const handleExport = async () => {
    const bundle = buildExportBundle({ session, result, report })
    const audit = auditExport(bundle)
    if (!audit.clean) {
      // Refuse rather than ship a file that might contain a credential. This should be
      // unreachable, which is exactly why it is checked.
      setExportMessage(
        `导出已中止：检测到可疑内容（${audit.findings.join('；')}）。请把这条信息反馈给开发者。`,
      )
      return
    }
    downloadJson(bundle, exportFileName(session, bundle.exportedAt))
    setExportMessage('JSON 已导出。文件里没有 API Key，只有本次作答与结构化结果。')
  }

  const handleGenerateReport = async () => {
    const apiKey = API_KEY_SESSION.get()
    if (!apiKey) {
      setReportStatus('failed', '还没有配置 API Key。请先到设置页填写，基础结果不受影响。')
      return
    }
    setReportStatus('generating')
    try {
      const provider = createProvider(settings.provider)
      const repos = await getRepositories()
      const generated = await generateReport({
        result,
        pack,
        config: settings.provider,
        apiKey,
        provider,
        reports: repos.reports,
      })
      setReport(generated.record)
      await saveSettings({ provider: settings.provider })
    } catch (error) {
      if (error instanceof ReportGenerationError) {
        const cause = error.cause
        // Reuse the same diagnosis vocabulary as "test connection" so the user sees one
        // consistent explanation for one underlying problem.
        const diagnosis =
          cause instanceof Error
            ? classifyError(cause, settings.provider)
            : { status: 'unknown_error' as const, message: error.message }
        setReportStatus(
          'failed',
          `${error.message}（${STATUS_LABELS[diagnosis.status]}：${diagnosis.message}）`,
        )
        return
      }
      setReportStatus('failed', error instanceof Error ? error.message : String(error))
    }
  }

  const keyConfigured = Boolean(API_KEY_SESSION.get() || settings.provider.providerId)

  return (
    <main className="page page-result">
      <h1>结构化结果</h1>
      <p className="subtitle">
        第一阶段评分全部在你的设备上完成，未调用任何 LLM。AI 综合报告是可选的最后一步。
      </p>

      <section className="card">
        <h2>本次记录</h2>
        <dl className="meta-list">
          <div>
            <dt>完成时间</dt>
            <dd>{result.generatedAt ? formatDateTime(result.generatedAt) : '(进行中)'}</dd>
          </div>
          <div>
            <dt>会话 ID</dt>
            <dd>{session.id}</dd>
          </div>
          <div>
            <dt>题库版本</dt>
            <dd>{result.versions.questionPack}</dd>
          </div>
          <div>
            <dt>评分版本</dt>
            <dd>{result.versions.scoring}</dd>
          </div>
          <div>
            <dt>角色模型版本</dt>
            <dd>{result.versions.roleModel}</dd>
          </div>
          <div>
            <dt>作答情况</dt>
            <dd>
              已答 {result.evidence.length} / {session.questionIds.length} 题
            </dd>
          </div>
        </dl>
        <p className="hint">摘要：{detail(result)}</p>
        {/*
          Persistence indicator. It exists so both a user and an automated test can tell when the
          result has actually reached IndexedDB: `finish()` writes asynchronously, and reloading
          before that write lands would show the previous state.
        */}
        <p
          className="hint"
          data-testid="persistence-state"
          data-persisted={Boolean(session.resultId)}
        >
          {session.resultId
            ? '本次结果已保存到本机浏览器，刷新或关闭后仍可从历史记录打开。'
            : '正在保存本次结果到本机…'}
        </p>
      </section>

      <section className="card notice notice-boundary">
        <h2>{RESULT_BOUNDARY_NOTICE.title}</h2>
        <ul>
          {RESULT_BOUNDARY_NOTICE.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      {/*
        A-layer V1.1 renders as six section cards (self-declared identity, theory familiarity, two
        sets of issue positions, practice orientation, reflexivity) rather than as four score rows.
        The A layer is not a score vector and must not be shown as one (DSH-MIGRATION-V1.1 §5).
        A result from an older pack has no `aLayerProfile` and falls through to the generic rows.
      */}
      {result.aLayerProfile ? (
        <ALayerSection
          profile={result.aLayerProfile}
          session={session}
          questionById={questionById}
        />
      ) : null}

      {LAYERS.filter((layer) => layer !== 'theory_value' || !result.aLayerProfile).map((layer) => {
        const rows = result.dimensions.filter((dimension) => dimension.layer === layer)
        if (rows.length === 0) return null
        return (
          <section className="card" key={layer} data-testid={`layer-${layer}`}>
            <h2>{LAYER_TITLES[layer]}</h2>
            <p className="hint">{LAYER_NOTES[layer]}</p>
            <ul className="profile-list">
              {rows.map((dimension) => {
                const numeric = (dimension.scoredItems ?? 1) > 0
                return (
                  <li
                    key={dimension.id}
                    className="profile-row"
                    data-testid={`dimension-${dimension.id}`}
                  >
                    <div className="profile-head">
                      <span className="profile-label">{dimension.label}</span>
                      {numeric ? (
                        <span className="profile-score">{dimension.normalizedScore}</span>
                      ) : (
                        <span className="profile-no-score">不产生分数</span>
                      )}
                    </div>
                    {numeric && <ProfileBar score={dimension.normalizedScore} />}
                    <div className="profile-meta">
                      {numeric ? (
                        <>
                          区间：{dimension.band} · 原始分 {dimension.rawScore}/
                          {dimension.maxPossible} · 题量 {dimension.answeredItems}/
                          {dimension.expectedItems} · 置信度 {formatPercent(dimension.confidence)}
                        </>
                      ) : (
                        <>本次作答 {dimension.answeredItems} 题（自我描述 / 描述性证据，不计分）</>
                      )}
                    </div>
                    {(dimension.warnings ?? []).length > 0 && (
                      <ul className="warning-list">
                        {(dimension.warnings ?? []).map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}
                    <details className="evidence">
                      <summary>这个判断主要来自哪些题目？</summary>
                      <ul>
                        {dimension.evidenceQuestionIds.map((questionId) => {
                          const question = questionById.get(questionId)
                          const chosenOptionId = session.answers[questionId]
                          const evidence = result.evidence.find(
                            (item) => item.questionId === questionId,
                          )
                          return (
                            <li key={questionId} data-testid={`evidence-${questionId}`}>
                              <p className="evidence-prompt">
                                <strong>{questionId}</strong>{' '}
                                {question?.prompt ?? '(题目已不在题库中)'}
                              </p>
                              <p className="evidence-answer">
                                你的作答：
                                {chosenOptionId
                                  ? optionText(questionId, chosenOptionId)
                                  : '(未作答)'}
                                {evidence && evidence.maxSignal > 0
                                  ? ` · 本维度信号：${evidence.signal} / ${evidence.maxSignal}`
                                  : ' · 该题不参与数值计分'}
                              </p>
                            </li>
                          )
                        })}
                      </ul>
                    </details>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

      <section className="card" data-testid="role-fit-section">
        <h2>角色适配（只使用 B / C 层维度）</h2>
        <p className="hint">
          下面的分数由合作与技能层维度加权得到，权重里不含任何理论层维度，也不是在判断「你是谁」。
        </p>
        <ul className="role-list">
          {result.roleFits.map((fit) => (
            <li key={fit.roleId} className="role-card" data-testid={`role-${fit.roleId}`}>
              <div className="profile-head">
                <span className="profile-label">{fit.name}</span>
                <span className="profile-score">{fit.fitScore}</span>
              </div>
              <ProfileBar score={fit.fitScore} />
              <p className="role-phrase">{fit.phrase}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" data-testid="consistency-section">
        <h2>回答一致性与稳定度</h2>
        <p className="hint">
          这一节只描述答卷内部的方向差异，不是「真实性」评分，也不能推出任何关于人的结论。
        </p>
        <dl className="meta-list">
          <div>
            <dt>回答一致性</dt>
            <dd>{formatPercent(result.consistency.answerConsistency)}</dd>
          </div>
          <div>
            <dt>最高档重复选择率</dt>
            <dd>{formatPercent(result.consistency.extremeRepeatRate)}</dd>
          </div>
          <div>
            <dt>需要进一步了解</dt>
            <dd>{result.consistency.needsFurtherUnderstanding ? '是' : '否'}</dd>
          </div>
        </dl>
        <ul className="finding-list">
          {result.consistency.findings.map((finding) => (
            <li key={finding.groupId}>
              <strong>
                {finding.groupId} · {finding.label}
              </strong>
              <span className="finding-questions">{finding.questionIds.join(' / ')}</span>
              <p>{finding.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>当前回答中较明显的方面</h2>
        <ul data-testid="strengths">
          {result.strengths.map((strength) => (
            <li key={strength}>{strength}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>可能需要更多信息的方向</h2>
        <ul data-testid="development-areas">
          {result.developmentAreas.map((area) => (
            <li key={area}>{area}</li>
          ))}
        </ul>
      </section>

      <ReportPanel
        report={report}
        status={reportStatus}
        error={reportError}
        isMock={report?.isMock ?? settings.provider.providerId === 'mock'}
        keyConfigured={keyConfigured}
        offline={offline}
        onToggleOffline={() => setOffline((value) => !value)}
        onGenerate={() => void handleGenerateReport()}
      />

      {/*
        Submission sits after the optional AI report and before the engine diagnostics: it is the
        step that actually hands the material to the requester, and it must be visible without
        scrolling past internal detail. It renders its own "not configured" state, so a local-only
        build says so instead of showing a dead button.
      */}
      <SubmitPanel />

      <section className="card">
        <h2>抽题引擎阶段实际状态</h2>
        <p className="hint">未激活的阶段如实标注，不假装执行过。</p>
        <ul className="stage-list">
          {result.samplerStages.map((stage) => (
            <li key={stage.stage}>
              <span className={stage.active ? 'tag tag-active' : 'tag'}>
                {stage.active ? '已激活' : '未激活'}
              </span>
              <code>{stage.stage}</code> {stage.reason}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>测评局限性</h2>
        <ul data-testid="limitations">
          {result.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>

      <div className="actions no-print">
        <button
          type="button"
          className="button primary"
          onClick={() => void handleExport()}
          data-testid="export-json"
        >
          导出 JSON
        </button>
        <button
          type="button"
          className="button"
          onClick={() => window.print()}
          data-testid="print-result"
        >
          打印 / 另存为 PDF
        </button>
        <Link className="button" to="/history">
          历史记录
        </Link>
        <Link className="button" to="/settings">
          AI 报告设置
        </Link>
      </div>
      {exportMessage && (
        <p className="hint" data-testid="export-message">
          {exportMessage}
        </p>
      )}
    </main>
  )
}
