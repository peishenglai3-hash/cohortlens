/**
 * Stub for `virtual:pwa-register` in the single-file delivery build.
 *
 * VitePWA supplies the real module through a build-time alias, and the delivery config does not load
 * VitePWA at all — a single-file page opened from `file://` has no origin to register a service
 * worker against. This stub exists so the import in `src/app/service-worker.ts` still resolves;
 * `registerServiceWorker()` already returns before calling it in that build.
 *
 * Anything reaching these functions is a wiring mistake, not a user-visible failure, so they warn
 * instead of throwing: a delivery artefact that silently breaks the whole app because of a PWA
 * detail would be a far worse outcome than losing offline caching.
 */

const message = '[CohortLens] 单文件交付版不提供 Service Worker（离线能力由"单文件本身"承担）。'

export function registerSW(_options?: unknown): (reloadPage?: boolean) => Promise<void> {
  console.warn(message)
  return async () => undefined
}

export function useRegisterSW(): never {
  throw new Error(`${message} useRegisterSW 不应在单文件交付版中被调用。`)
}

export default registerSW
