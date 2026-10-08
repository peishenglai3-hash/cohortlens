import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

/**
 * 甲方交付版（Delivery build）—— 单文件离线包。
 *
 * 这个配置**不是**给日常开发用的，它产出的是甲方收到后可以直接双击打开的一份 HTML。
 * 与主配置 `vite.config.ts` 的三点差别都是刻意的：
 *
 *   1. **不注册 Service Worker。** 单文件版从 `file://` 打开时没有安全上下文，注册一定失败；
 *      而 `virtual:pwa-register` 是 PWA 插件在构建期提供的虚拟模块，所以这个配置里
 *      **完全不加载 VitePWA**。没有 SW，也就没有"离线可用"的说法——但单文件本身就是离线的：
 *      所有 JS/CSS/内容都已经内联在这一份文件里，没有任何外部请求。
 *   2. **不产出 sourcemap。** 交付物不该带源码映射；主配置保留 sourcemap 是为了本地调试。
 *   3. **全部内联。** JS/CSS/图标/题库都进同一个 HTML，因此 `dist-delivery/app.html`
 *      可以单独拷走、放进邮件附件、或者拷到一台完全离线的机器上使用。
 *
 * base 固定为 `./`：单文件版没有相对路径可解析，但保持与主配置一致可以避免"两个构建的产物
 * 行为不同"这类意外。
 *
 * 用法：`npm run build:delivery`
 */
const base = './'

const appConfig = JSON.parse(
  readFileSync(new URL('./application.json', import.meta.url), 'utf8'),
) as { name: string; shortName: string; description: string; themeColor: string }

function htmlTitlePlugin() {
  return {
    name: 'cohortlens-html-title-delivery',
    /**
     * Two jobs, in order: retitle the page, then make the document genuinely self-contained.
     *
     * The app shell (`index.html`) links a web manifest and two icon files. Those are correct for
     * the hosted build and wrong for this one: a single HTML opened from `file://` would issue three
     * requests that can never resolve, and in some browsers a failed `manifest` fetch shows up in
     * the console as a visible error. Neither the manifest nor the touch icon does anything useful
     * without an installable origin, so both links are removed and the favicon is inlined as a data
     * URL — the tab keeps its icon, and the file references nothing outside itself.
     */
    transformIndexHtml(html: string): string {
      const titled = html
        .replace(/<title>.*<\/title>/, `<title>${appConfig.name}（离线单文件版）</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${appConfig.description}$2`)
        .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${appConfig.themeColor}$2`)
        .replace(
          /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
          `$1${appConfig.shortName}$2`,
        )

      const withoutPwaLinks = titled
        .replace(/\s*<link[^>]*rel="manifest"[^>]*>/i, '')
        .replace(/\s*<link[^>]*rel="apple-touch-icon"[^>]*>/i, '')

      return withoutPwaLinks.replace(
        /\s*<link[^>]*rel="icon"[^>]*>/i,
        `\n    <link rel="icon" href="${faviconDataUrl()}" />`,
      )
    },
  }
}

/** Inline the 32x32 PNG as a data URL so the single file has no companion assets at all. */
function faviconDataUrl(): string {
  const bytes = readFileSync(new URL('./public/icons/favicon-32x32.png', import.meta.url))
  return `data:image/png;base64,${bytes.toString('base64')}`
}

export default defineConfig({
  base,
  plugins: [react(), htmlTitlePlugin(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /**
       * `virtual:pwa-register` is provided by VitePWA, which this config deliberately does not
       * load. Aliasing it to a stub keeps the import resolvable while making the call a no-op —
       * the alternative would be to duplicate the whole app entry just to skip one import.
       */
      'virtual:pwa-register': fileURLToPath(
        new URL('./src/app/pwa-register-stub.ts', import.meta.url),
      ),
    },
  },
  define: {
    /**
     * `src/app/service-worker.ts` reads this. Setting it false lets the bundler drop the dynamic
     * import of `virtual:pwa-register` entirely, so this build never references a module the PWA
     * plugin would have provided.
     */
    __COHORTLENS_PWA_ENABLED__: 'false',
  },
  build: {
    outDir: 'dist-delivery',
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        // One chunk, one file. Anything split out would become a second file to ship.
        inlineDynamicImports: true,
      },
    },
  },
})
