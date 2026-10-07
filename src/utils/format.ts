/** Small display helpers shared by the pages. */

/** Local, human-readable timestamp. Falls back to the raw value when it is not parseable. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function formatPercent(value01: number): string {
  return `${Math.round(value01 * 100)}%`
}

/** Mask a secret for display: never show more than a prefix and suffix. */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim()
  if (trimmed.length <= 8) return '•'.repeat(Math.max(4, trimmed.length))
  return `${trimmed.slice(0, 4)}${'•'.repeat(8)}${trimmed.slice(-4)}`
}
