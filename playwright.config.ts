import { defineConfig, devices } from '@playwright/test'

const port = process.env.MAIL_REVIEW_TEST_PORT ?? '4173'
const baseURL = `http://127.0.0.1:${port}`
const telemetryPort = process.env.MAIL_REVIEW_TELEMETRY_TEST_PORT ?? String(Number(port) + 1)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Both browser projects exercise the same single-user SQLite instance.
  // Serial workers prevent one test from mutating another test's active round.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: process.env.REVIEW_EVIDENCE_DIR ? 'on' : 'off',
  },
  webServer: {
    command: 'pnpm build && pnpm exec tsx scripts/start-e2e.ts',
    env: {
      CODEX_HOME: 'test-results/codex-home',
      DATA_DIR: 'test-results/runtime-data',
      HOST: '127.0.0.1',
      MAIL_REVIEW_DEMO: '1',
      PORT: port,
      MAIL_REVIEW_TELEMETRY_TEST_PORT: telemetryPort,
    },
    url: `${baseURL}/api/todo`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', testIgnore: 'telemetry.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', testIgnore: 'telemetry.spec.ts', use: { ...devices['Pixel 7'] } },
    {
      name: 'telemetry',
      testMatch: 'telemetry.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${telemetryPort}` },
    },
  ],
})
