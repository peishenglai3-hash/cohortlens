import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { HomePage } from '../pages/Home/HomePage.tsx'
import { AssessmentPage } from '../pages/Assessment/AssessmentPage.tsx'
import { ResultPage } from '../pages/Result/ResultPage.tsx'
import { AboutPage } from '../pages/About/AboutPage.tsx'
import { PRODUCT_CONFIG } from '../config/product.ts'

/**
 * Application shell.
 *
 * Routing uses a **hash router** on purpose. Engineering Bible §2 requires the built output to
 * run from plain static hosting, including GitHub Pages, and §41/§42 require a configurable base
 * path. A hash router keeps deep links working without server rewrites, so a static host needs no
 * configuration beyond the base path — which matters more here than clean URLs do.
 */

class AppErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  override state: { message: string | null } = { message: null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Production logging must never print an API key or a full report payload (§53). A component
    // stack plus a generic message is safe.
    console.error('[CohortLens] 应用级错误边界捕获到异常', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children
    return (
      <main className="page">
        <h1>应用遇到错误</h1>
        <p>已停止渲染，以避免显示不完整或错误的结果。已保存的数据不受影响。</p>
        <pre className="error-detail">{this.state.message}</pre>
        <button type="button" onClick={() => this.setState({ message: null })}>
          返回
        </button>
      </main>
    )
  }
}

const router = createHashRouter([
  { path: '/', element: <HomePage /> },
  { path: '/assessment', element: <AssessmentPage /> },
  { path: '/result', element: <ResultPage /> },
  { path: '/about', element: <AboutPage /> },
])

export function App(): ReactNode {
  return (
    <AppErrorBoundary>
      <header className="app-header">
        <a className="app-brand" href="#/">
          {PRODUCT_CONFIG.name}
        </a>
        <nav className="app-nav">
          <a href="#/">首页</a>
          <a href="#/about">关于</a>
        </nav>
      </header>
      <RouterProvider router={router} />
      <footer className="app-footer">
        <p>
          {PRODUCT_CONFIG.name} · 本地优先结构化测评工具 ·
          数据默认只保存在当前设备，本项目没有中心服务器。
        </p>
      </footer>
    </AppErrorBoundary>
  )
}
