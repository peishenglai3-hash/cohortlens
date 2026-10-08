import { registerSW } from 'virtual:pwa-register'

/**
 * Service worker registration — Engineering Bible §40, Local MVP brief §21/§23.
 *
 * `autoUpdate` means a new build takes over on the next load without prompting the user, which is
 * the right trade-off for a single-user local tool: there is no multi-user coordination to
 * protect, and a stale cached report screen is worse than an unannounced reload.
 *
 * Registration is best-effort. If it fails (a browser with service workers disabled, an insecure
 * origin other than localhost), the app keeps working as a plain static page — offline support
 * degrades, nothing breaks.
 *
 * `__COHORTLENS_PWA_ENABLED__` is substituted at build time. The delivery build (the single-file
 * bundle from `vite.config.delivery.ts`) sets it to `false`, because that build loads from
 * `file://` where no service worker can register, and it has no PWA plugin to supply
 * `virtual:pwa-register` at all. The delivery config also aliases that module to a no-op stub, so
 * the import above never resolves to a missing virtual module.
 */
declare const __COHORTLENS_PWA_ENABLED__: boolean | undefined

const pwaEnabled: boolean =
  typeof __COHORTLENS_PWA_ENABLED__ === 'undefined' ? true : __COHORTLENS_PWA_ENABLED__

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return
  if (!pwaEnabled) return
  if (!('serviceWorker' in navigator)) return
  // A `file://` page has an opaque origin; registration would throw rather than degrade.
  if (window.location.protocol === 'file:') return
  try {
    registerSW({
      immediate: true,
      onRegisterError(error: unknown) {
        console.warn(
          '[CohortLens] Service Worker 注册失败，离线能力不可用，应用其余功能正常。',
          error,
        )
      },
    })
  } catch (error) {
    console.warn('[CohortLens] Service Worker 不可用。', error)
  }
}
