import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

/**
 * Engineering Bible §42 (Base Path).
 *
 * `username.github.io/repo-name/` must work, so the base path is configurable and never
 * hard-coded. Absolute asset paths are forbidden in source; use `src/utils/ids.ts#assetUrl`,
 * which reads Vite's `BASE_URL`.
 *
 * Default: './' — the output is relative, so `dist/` also works from a file:// URL, an arbitrary
 * nested directory, or any static host without configuration.
 * GitHub Pages: VITE_BASE=/repo-name/ npm run build
 *   e.g. VITE_BASE=/cohortlens/ npm run build  ->  every asset becomes /cohortlens/assets/...
 */
const base = process.env.VITE_BASE ?? './'

/**
 * The app name is read from application.json so the tab title, the PWA manifest and the in-app
 * ProductConfig cannot drift apart (Engineering Bible §64: the product name is configurable and
 * must not be hard-coded in business logic).
 */
const appConfig = JSON.parse(
  readFileSync(new URL('./application.json', import.meta.url), 'utf8'),
) as {
  name: string
  shortName: string
  description: string
  themeColor: string
  backgroundColor: string
}

/**
 * Keep `index.html` in step with application.json so a rename is genuinely one file. Without this
 * the name would live in three places (JSON, HTML title, ProductConfig) and drift.
 */
function htmlTitlePlugin() {
  return {
    name: 'cohortlens-html-title',
    transformIndexHtml(html: string): string {
      return html
        .replace(/<title>.*<\/title>/, `<title>${appConfig.name}</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${appConfig.description}$2`)
        .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${appConfig.themeColor}$2`)
        .replace(
          /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
          `$1${appConfig.shortName}$2`,
        )
    },
  }
}

export default defineConfig({
  base,
  plugins: [
    react(),
    htmlTitlePlugin(),
    /**
     * PWA — Engineering Bible §40, Local MVP brief §21/§23.
     *
     * Deliberately minimal: precache the app shell and the bundled content, serve navigations from
     * cache so the app opens offline, and update on the next load. No push notifications, no
     * background sync, no remote update service, no elaborate runtime caching — those are excluded
     * by the brief and would only add ways to fail.
     *
     * Verified locally with `npm run build` + `npm run preview`; this is NOT a claim that a
     * production deployment has been verified (publish track is deferred).
     */
    VitePWA({
      registerType: 'autoUpdate',
      // Registration is owned by `src/app/service-worker.ts`, which degrades quietly when service
      // workers are unavailable. The plugin must therefore not inject a second registration.
      injectRegister: null,
      // The service worker and manifest must be reachable from the deployed base path.
      base: `${base.endsWith('/') ? base : `${base}/`}`,
      scope: base,
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32x32.png'],
      manifest: {
        name: appConfig.name,
        short_name: appConfig.shortName,
        description: appConfig.description,
        lang: 'zh-CN',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        theme_color: appConfig.themeColor,
        background_color: appConfig.backgroundColor,
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // No runtime caching rules: every asset the app needs is precached at install time.
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Engineering Bible §49: the scoring, sampler and role-fit engines target >=90% lines.
      include: ['src/engine/**/*.ts', 'src/domain/**/*.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
})
