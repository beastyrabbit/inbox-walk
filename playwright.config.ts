import { defineConfig, devices } from '@playwright/test'

const port = process.env.MAIL_REVIEW_TEST_PORT ?? '4173'
const baseURL = `http://127.0.0.1:${port}`

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
    command: 'pnpm build && pnpm start',
    env: {
      DATA_DIR: 'test-results/runtime-data',
      HOST: '127.0.0.1',
      MAIL_REVIEW_DEMO: '1',
      PORT: port,
    },
    url: `${baseURL}/api/review/options`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
})
