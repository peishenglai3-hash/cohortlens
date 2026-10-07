import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

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

export default defineConfig({
  base,
  plugins: [react()],
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
