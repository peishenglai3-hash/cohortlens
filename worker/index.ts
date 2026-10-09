import { handleApi } from './api.ts'
import type { Env } from './env.ts'

/**
 * Worker 入口。
 *
 * 只做两件事：把 `/api/*` 交给 API 路由，其余请求交给静态资源绑定（审阅台前端）。
 *
 * 这里**没有**把审阅台前端也塞进这个文件的构建里——审阅台是独立的一份产物
 * （`npm run build:admin` → `worker/assets/`），由 wrangler 的 `assets` 绑定直接服务。
 * 分开的理由是两者的受众完全不同：作答端要发给陌生人、必须轻、必须能离线；审阅台只给甲方、
 * 依赖网络、可以慢一点。把它们编进同一个产物会让作答端平白多背一份没人用的代码。
 */
/**
 * The handler shape, declared explicitly rather than via Cloudflare's `ExportedHandler` global.
 * See `worker/env.ts` for why this project does not pull in `@cloudflare/workers-types`:
 * those globals collide with the DOM lib and silently remove `indexedDB` from the app.
 */
export interface WorkerModule {
  fetch(request: Request, env: Env): Promise<Response>
}

const worker: WorkerModule = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env)
    }

    /**
     * 没有配置 assets 绑定时（例如只跑 API 的本地测试）给出明确提示，而不是一个空白的 404。
     * 这类"部署少配了一项"的问题如果只表现为 404，会被当成前端没打包好而查错方向。
     */
    const assets = (
      env as unknown as { ASSETS?: { fetch: (request: Request) => Promise<Response> } }
    ).ASSETS
    if (!assets) {
      return new Response(
        '审阅台静态资源未绑定（缺少 ASSETS 绑定）。API 本身可用：试试 GET /api/health。',
        { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }
    return assets.fetch(request)
  },
}

export default worker
