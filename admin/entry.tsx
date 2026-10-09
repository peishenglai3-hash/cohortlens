import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AdminApp } from './AdminApp.tsx'

/**
 * 审阅台入口。
 *
 * 与作答端完全分开的一份产物：作答端要发给陌生人、必须轻、必须能离线；审阅台只给甲方、
 * 依赖网络、可以慢一点。编进同一个产物只会让作答端平白多背一份没人用的代码。
 *
 * 没有路由库：审阅台只有"一页列表 + 展开一份材料"，用 `useState` 表达比引入一个 router 更诚实。
 */
const container = document.getElementById('admin-root')
if (!container) throw new Error('审阅台缺少 #admin-root 挂载点')

createRoot(container).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)
