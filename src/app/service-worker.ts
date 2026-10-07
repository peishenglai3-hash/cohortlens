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
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
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
