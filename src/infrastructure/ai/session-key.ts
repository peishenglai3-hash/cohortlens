/**
 * Session-scoped API key holder — Engineering Bible §31.
 *
 * Default behaviour: the key lives only for the current browser session. `sessionStorage` is
 * cleared by the browser when the tab or window closes, and it is not shared between tabs, which
 * matches "Key 只存在当前 Session，页面关闭后清除".
 *
 * An in-memory fallback covers environments that block `sessionStorage`, so entering a key never
 * crashes the page.
 *
 * Nothing here is claimed to be secure storage. §31 forbids saying that browser storage makes a
 * long-lived key safe, and the UI repeats that instead of pretending otherwise. Persistent
 * "记住此设备" storage is a separate, explicit opt-in handled by SettingsRepository.saveSecret.
 */

const SESSION_KEY = 'cohortlens.provider.apiKey'

let memoryKey = ''

export const API_KEY_SESSION = {
  get(): string {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY)
      return stored ?? memoryKey
    } catch {
      return memoryKey
    }
  },

  set(apiKey: string): void {
    memoryKey = apiKey
    try {
      if (apiKey) sessionStorage.setItem(SESSION_KEY, apiKey)
      else sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // Storage blocked: the in-memory copy still works for this page's lifetime.
    }
  },

  clear(): void {
    memoryKey = ''
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // nothing to do
    }
  },

  has(): boolean {
    return API_KEY_SESSION.get().trim().length > 0
  },

  /** Masked form for display. Never returns enough characters to reconstruct the key. */
  masked(): string {
    const value = API_KEY_SESSION.get()
    if (!value) return ''
    if (value.length <= 8) return '•'.repeat(value.length)
    return `${value.slice(0, 3)}${'•'.repeat(10)}${value.slice(-3)}`
  },
}
