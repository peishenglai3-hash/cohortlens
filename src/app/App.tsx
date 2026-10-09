import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { createHashRouter, Link, RouterProvider } from 'react-router-dom'
import { HomePage } from '../pages/Home/HomePage.tsx'
import { AssessmentPage } from '../pages/Assessment/AssessmentPage.tsx'
import { ResultPage } from '../pages/Result/ResultPage.tsx'
import { HistoryPage } from '../pages/History/HistoryPage.tsx'
import { SettingsPage } from '../pages/Settings/SettingsPage.tsx'
import { AboutPage } from '../pages/About/AboutPage.tsx'
import { PRODUCT_CONFIG } from '../config/product.ts'
import { readInviteFromHash } from '../config/submission-config.ts'
import { useAppStore } from './store.ts'

/**
 * Application shell.
 *
 * Routing uses a **hash router** on purpose. Engineering Bible §2 requires the built output to run
 * from plain static hosting, including GitHub Pages, and §41/§42 require a configurable base path.
 * A hash router keeps deep links working without server rewrites, so a static host needs no
 * configuration beyond the base path — which matters more here than clean URLs do.
 *
 * The shell owns the single boot call: it loads settings, the in-progress session, its result and
 * its report from IndexedDB before rendering a page that depends on them.
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
        <p>已停止渲染，以避免显示不完整或错误的结果。已经保存在本机的数据不受影响。</p>
        <pre className="error-detail">{this.state.message}</pre>
        <div className="actions">
          <button type="button" onClick={() => this.setState({ message: null })}>
            返回
          </button>
          <a className="button" href="#/">
            回首页
          </a>
        </div>
      </main>
    )
  }
}

const router = createHashRouter([
  { path: '/', element: <HomePage /> },
  { path: '/assessment', element: <AssessmentPage /> },
  { path: '/result', element: <ResultPage /> },
  { path: '/history', element: <HistoryPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '/about', element: <AboutPage /> },
])

function Shell() {
  const bootStatus = useAppStore((state) => state.bootStatus)
  const bootError = useAppStore((state) => state.bootError)
  const boot = useAppStore((state) => state.boot)
  const adoptInviteCode = useAppStore((state) => state.adoptInviteCode)

  useEffect(() => {
    if (bootStatus === 'idle') void boot()
  }, [bootStatus, boot])

  /**
   * Adopt the invite code carried by the link the requester sent.
   *
   * Reading it from `location.hash` rather than from the router keeps this working regardless of
   * which route the link points at (`#/?invite=X` and `#/assessment?invite=X` both work), and it
   * survives a refresh because the code is written into settings. Losing the code mid-assessment
   * would leave the respondent unable to submit with no idea why.
   */
  useEffect(() => {
    if (bootStatus !== 'ready') return
    const code = readInviteFromHash(window.location.hash)
    if (code) void adoptInviteCode(code)
  }, [bootStatus, adoptInviteCode])

  if (bootStatus === 'idle' || bootStatus === 'loading') {
    return (
      <main className="page">
        <h1>正在载入本地数据…</h1>
        <p className="hint">读取本机浏览器中的测评记录与设置。这一步不需要联网。</p>
      </main>
    )
  }

  if (bootStatus === 'error') {
    return (
      <main className="page">
        <h1>无法读取本地数据</h1>
        <p>浏览器的本地存储可能被禁用或已损坏。核心测评仍然可用，但刷新后不会保留进度。</p>
        <pre className="error-detail">{bootError ?? '(无详细信息)'}</pre>
        <div className="actions">
          <Link className="button primary" to="/assessment">
            仍然开始测评
          </Link>
        </div>
      </main>
    )
  }

  return (
    <>
      {bootStatus === 'persistence-unavailable' && (
        <div className="banner banner-warn" role="status" data-testid="persistence-warning">
          当前浏览器不允许使用本地数据库，本次测评的进度在刷新后会丢失。
          {bootError ? <span className="banner-detail">{bootError}</span> : null}
        </div>
      )}
      {bootError && bootStatus === 'ready' && (
        <div className="banner banner-warn" role="status" data-testid="boot-warning">
          {bootError}
        </div>
      )}
      <RouterProvider router={router} />
    </>
  )
}

export function App(): ReactNode {
  return (
    <AppErrorBoundary>
      <header className="app-header no-print">
        <a className="app-brand" href="#/">
          {PRODUCT_CONFIG.name}
        </a>
        <nav className="app-nav">
          <a href="#/">首页</a>
          <a href="#/assessment">测评</a>
          <a href="#/history">历史</a>
          <a href="#/settings">设置</a>
          <a href="#/about">关于</a>
        </nav>
      </header>
      <Shell />
      <footer className="app-footer no-print">
        <p>
          {PRODUCT_CONFIG.name} · 本地优先结构化测评工具 ·
          数据只保存在当前设备，本项目没有中心服务器。
        </p>
      </footer>
    </AppErrorBoundary>
  )
}
