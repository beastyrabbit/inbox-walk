import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { createApiMiddleware, waitForApiJobs } from './server/api.ts'
import { createBundleStore } from './server/bundle-store.ts'
import { createReviewHistory } from './server/review-history.ts'
import { createRoundStore } from './server/round-store.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of [
    'CODEX_BUNDLE_MAX_CALLS',
    'CODEX_INFERENCE_TIMEOUT_MS',
    'CODEX_MODEL',
    'DATA_DIR',
    'TIKA_URL',
  ]) {
    if (!process.env[key] && env[key]) process.env[key] = env[key]
  }
  const apiOptions = {
    fastmailToken: process.env.FASTMAIL_JMAP_TOKEN || env.FASTMAIL_JMAP_TOKEN,
    forceDemo: (process.env.MAIL_REVIEW_DEMO || env.MAIL_REVIEW_DEMO) === '1',
  }
  return {
    server: {
      host: process.env.HOST || '127.0.0.1',
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
      strictPort: Boolean(process.env.PORT),
    },
    plugins: [
      react(),
      {
        name: 'mail-review-api',
        configureServer(server) {
          const reviewHistory = createReviewHistory()
          const bundleStore = createBundleStore()
          const roundStore = createRoundStore()
          server.middlewares.use(
            createApiMiddleware({ ...apiOptions, bundleStore, reviewHistory, roundStore }),
          )
          server.httpServer?.once('close', () => {
            void waitForApiJobs().finally(() => {
              reviewHistory.close()
              bundleStore.close()
              roundStore.close()
            })
          })
        },
      },
    ],
  }
})
