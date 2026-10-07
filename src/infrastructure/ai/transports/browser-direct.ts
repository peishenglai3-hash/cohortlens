import type { AITransport, ProviderConfig } from '../types.ts'

/**
 * BrowserDirectTransport — Engineering Bible §32.
 *
 * Issues the request straight from the browser to the user's own endpoint with the user's own
 * key. This is the V0.1 transport, and it only works against services that explicitly allow
 * client-side BYOK and send permissive CORS headers.
 *
 * If a provider refuses browser access, this transport does NOT try to work around it: there is no
 * proxy, no tunnel, no hidden server. The failure is reported as `cors_restriction` and the UI
 * tells the user to pick a browser-friendly compatible service or wait for the desktop
 * LocalBridge (Local MVP brief §15).
 */

export class BrowserDirectTransport implements AITransport {
  readonly kind = 'browser-direct' as const
  readonly available = true

  async request(
    config: ProviderConfig,
    apiKey: string,
    request: {
      path: string
      method: 'GET' | 'POST'
      body?: unknown
      timeoutMs: number
    },
  ): Promise<{ status: number; json: unknown; text: string }> {
    const url = joinUrl(config.baseURL, request.path)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: {
          // The key goes in the Authorization header only. It is never put in the URL, never
          // logged, and never echoed into an error message (Engineering Bible §53).
          Authorization: `Bearer ${apiKey}`,
          ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        // `null` rather than `undefined`: with exactOptionalPropertyTypes, an explicitly-undefined
        // body is not assignable to RequestInit.body.
        body: request.body === undefined ? null : JSON.stringify(request.body),
        signal: controller.signal,
      })
      const text = await response.text()
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      return { status: response.status, json, text }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * LocalBridgeTransport — reserved for a future Tauri build (Engineering Bible §33).
 *
 * Deliberately NOT implemented in this phase (Local MVP brief §16): the interface exists so the
 * React layer never has to change when the native bridge lands. `available: false` makes the
 * Settings UI disable the option instead of failing at request time.
 */
export class LocalBridgeTransport implements AITransport {
  readonly kind = 'local-bridge' as const
  readonly available = false

  async request(): Promise<{ status: number; json: unknown; text: string }> {
    throw new Error(
      'LocalBridge 传输层尚未实现：它需要 Tauri 原生桥接，属于桌面版本的工作。当前请在设置中选择 Browser Direct。',
    )
  }
}
