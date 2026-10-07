import { defineConfig, devices } from '@playwright/test'

/**
 * Local Playwright configuration — Local MVP brief §24.
 *
 * Local only, on purpose: this run is never wired to a GitHub runner, and the publish track is
 * deferred. `webServer` starts the built static output with `vite preview`, so the E2E run
 * exercises the same artefacts a user would open rather than the dev server.
 *
 * Browsers: Playwright 1.62.0 matches the Chromium build already present in this machine's
 * playwright cache, so no browser download is required.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // The app keeps a single "current session" in IndexedDB; running specs in parallel against one
  // origin would make them fight over it.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    // `localhost`, not `127.0.0.1`: `vite preview` binds the hostname, which on this machine
    // resolves to ::1 first, so an IPv4-only URL would never connect.
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      // Engineering Bible §56: the primary target screen is 375px wide.
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
