import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * 审阅台构建 —— 独立于作答端。
 *
 * 产物落到 `worker/assets/`，由 wrangler 的 `assets` 绑定直接服务。放在这个目录里而不是 `dist/`，
 * 是因为两者的部署目标是不同的东西：`dist/` 是发给作答者的静态站（Pages），
 * `worker/assets/` 是审阅台（跟 Worker 一起部署）。混在一起会导致每次部署前端都顺手把审阅台
 * 也发到公网上——审阅台只该出现在 Worker 那个域名下，且要口令。
 *
 * `base: './'`：审阅台挂在 Worker 域名根路径下，相对路径即可，不需要知道域名。
 */
export default defineConfig({
  root: 'admin',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../worker/assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
})
