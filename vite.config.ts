import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { createApiMiddleware } from './server/api.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['CODEX_INFERENCE_TIMEOUT_MS', 'CODEX_MODEL', 'DATA_DIR', 'TIKA_URL']) {
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
          server.middlewares.use(createApiMiddleware(apiOptions))
        },
      },
    ],
  }
})
