import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { abortApiJobs, createApiMiddleware, waitForApiJobs } from './server/api.ts'
import { createBundleStore } from './server/bundle-store.ts'
import { createReviewHistory } from './server/review-history.ts'
import { createRoundStore } from './server/round-store.ts'

const packageMetadata = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version?: unknown }

if (typeof packageMetadata.version !== 'string' || !packageMetadata.version.trim()) {
  throw new Error('package.json must contain a non-empty version.')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of [
    'CODEX_BUNDLE_TIMEOUT_MS',
    'CODEX_INFERENCE_TIMEOUT_MS',
    'CODEX_MODEL',
    'CODEX_THINKING_LEVEL',
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
    define: {
      __APP_VERSION__: JSON.stringify(packageMetadata.version),
    },
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
            abortApiJobs()
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
