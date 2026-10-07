import type { AssessmentResult, AssessmentSession } from '../../domain/schemas.ts'
import type { ReportRecord } from '../storage/report-repository.ts'

/**
 * JSON export — Engineering Bible §38, Local MVP brief §9.
 *
 * Content: session metadata, version metadata, the answer sheet, the structured result, and AI
 * report metadata when one exists.
 *
 * **No API key, ever.** The key is not part of these types and `buildExportBundle` takes no secret
 * argument, so there is no code path through which a key could reach an export file. The export is
 * additionally swept for key-shaped strings before it is handed to the browser, as a second line
 * of defence against a key ending up inside a model's report text.
 */

export const EXPORT_FORMAT = 'cohortlens-export'
export const EXPORT_FORMAT_VERSION = '1.0'

export interface ExportReportSection {
  createdAt: string
  provider: Omit<ReportRecord['provider'], never>
  versions: ReportRecord['versions']
  content: string
  durationMs: number
  isMock: boolean
  usage?: ReportRecord['usage']
  sanitizedViolations?: string[]
}

export interface ExportBundle {
  format: typeof EXPORT_FORMAT
  formatVersion: string
  exportedAt: string
  note: string
  session: {
    id: string
    createdAt: string
    updatedAt: string
    completedAt?: string
    status: AssessmentSession['status']
    seed: string
    questionIds: string[]
    answers: Record<string, string>
    shortDimension?: string | null
  }
  versions: {
    questionPackId: string
    questionPackVersion: string
    scoringVersion: string
    roleModelVersion: string
  }
  result: AssessmentResult
  report: ExportReportSection | null
}

export interface BuildExportInput {
  session: AssessmentSession
  result: AssessmentResult
  report?: ReportRecord | null
  exportedAt?: string
}

export function buildExportBundle({
  session,
  result,
  report,
  exportedAt,
}: BuildExportInput): ExportBundle {
  const sessionSection: ExportBundle['session'] = {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    seed: session.seed,
    questionIds: [...session.questionIds],
    answers: { ...session.answers },
  }
  if (session.completedAt !== undefined) sessionSection.completedAt = session.completedAt
  if (session.shortDimension !== undefined) sessionSection.shortDimension = session.shortDimension

  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    note: '本文件由 CohortLens 在本地生成。不含任何 API Key 或凭据。作答内容属于个人信息，请自行妥善保管。',
    session: sessionSection,
    versions: {
      questionPackId: session.questionPackId,
      questionPackVersion: session.questionPackVersion,
      scoringVersion: session.scoringVersion,
      roleModelVersion: session.roleModelVersion,
    },
    result,
    report: report ? toExportReport(report) : null,
  }
}

function toExportReport(report: ReportRecord): ExportReportSection {
  const section: ExportReportSection = {
    createdAt: report.createdAt,
    provider: report.provider,
    versions: report.versions,
    content: report.content,
    durationMs: report.durationMs,
    isMock: report.isMock,
  }
  if (report.usage) section.usage = report.usage
  if (report.sanitizedViolations) section.sanitizedViolations = report.sanitizedViolations
  return section
}

/**
 * Key-shaped strings. Deliberately conservative: false positives only cost a warning, while a
 * missed key costs a leaked credential.
 */
const KEY_SHAPES: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
]

export function findKeyLikeStrings(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of KEY_SHAPES) {
    for (const match of text.matchAll(pattern)) found.add(match[0].slice(0, 8) + '…')
  }
  return [...found]
}

export interface ExportAudit {
  clean: boolean
  findings: string[]
}

/** Pre-flight check run before a download is offered. */
export function auditExport(bundle: ExportBundle): ExportAudit {
  const serialised = JSON.stringify(bundle)
  const findings = findKeyLikeStrings(serialised)
  const declaredKeyFields = ['"apiKey"', '"api_key"', '"secret"', '"password"', '"token"']
  for (const field of declaredKeyFields) {
    if (serialised.includes(field)) findings.push(`导出内容包含疑似凭据字段 ${field}`)
  }
  return { clean: findings.length === 0, findings }
}

export function exportFileName(session: AssessmentSession, exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-').slice(0, 19)
  return `cohortlens-${session.id}-${stamp}.json`
}

/** Trigger a browser download. No-op in non-browser environments (tests call the builder instead). */
export function downloadJson(bundle: ExportBundle, fileName: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
