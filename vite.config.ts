import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { serveLegalPage } from './server/legal/pages.ts'
import { rejectUnsafeRequestPath } from './server/request-path.ts'
import { createRuntime } from './server/runtime.ts'

const packageMetadata = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version?: unknown }

if (typeof packageMetadata.version !== 'string' || !packageMetadata.version.trim()) {
  throw new Error('package.json must contain a non-empty version.')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of [
    'CODEX_INFERENCE_TIMEOUT_MS',
    'CODEX_MODEL',
    'CODEX_THINKING_LEVEL',
    'DATA_DIR',
    'TIKA_URL',
    'TRIAGE_POLL_INTERVAL_MS',
    'TRIAGE_TIMEOUT_MS',
    'UMAMI_URL',
    'UMAMI_WEBSITE_ID',
    'UMAMI_REPLAY',
    'GLITCHTIP_DSN',
    'GLITCHTIP_ENVIRONMENT',
    'GLITCHTIP_TRACES_SAMPLE_RATE',
  ]) {
    if (!process.env[key] && env[key]) process.env[key] = env[key]
  }
  const runtimeOptions = {
    fastmailToken: process.env.FASTMAIL_JMAP_TOKEN || env.FASTMAIL_JMAP_TOKEN,
    forceDemo: (process.env.MAIL_REVIEW_DEMO || env.MAIL_REVIEW_DEMO) === '1',
  }
  return {
    build: { sourcemap: 'hidden' },
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
          server.middlewares.use((req, res, next) => {
            if (rejectUnsafeRequestPath(req, res)) return
            if (!serveLegalPage(req, res)) next()
          })
          const runtime = createRuntime(runtimeOptions)
          server.middlewares.use(runtime.api)
          server.httpServer?.once('listening', () => runtime.start())
          server.httpServer?.once('close', () => void runtime.close())
        },
      },
    ],
  }
})
