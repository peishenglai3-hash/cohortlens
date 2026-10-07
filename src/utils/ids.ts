/**
 * Small shared helpers. Deliberately dependency-free so the engine can be tested in isolation.
 */

/** RFC 4122 id. Uses the platform CSPRNG when present, and a documented fallback otherwise. */
export function createId(prefix: string): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoRef?.randomUUID) return `${prefix}_${cryptoRef.randomUUID()}`
  const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)
  return `${prefix}_${Date.now().toString(36)}${random}`
}

/** Seed value for a new assessment (Engineering Bible §12). */
export function createSeed(): string {
  return createId('seed')
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Resolve a `public/` asset against the configured base path.
 * Engineering Bible §42 forbids literal `/assets/...` paths, because GitHub Pages serves the app
 * from `/<repo-name>/`. Reads Vite's `BASE_URL`, which `vite.config.ts` derives from VITE_BASE.
 *
 * `import.meta.env` is read through a cast so this module also type-checks and runs under plain
 * Node (`scripts/*`, vitest), where Vite's env object does not exist.
 */
export function assetUrl(pathFromPublic: string): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env
  const base = env?.BASE_URL ?? '/'
  const normalisedBase = base.endsWith('/') ? base : `${base}/`
  const normalisedPath = pathFromPublic.replace(/^\/+/, '')
  return `${normalisedBase}${normalisedPath}`
}

export function formatPercent(value01: number): string {
  return `${Math.round(value01 * 100)}%`
}
