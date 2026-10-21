import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const port = process.env.PORT ?? '4173'
const telemetryPort = process.env.MAIL_REVIEW_TELEMETRY_TEST_PORT ?? String(Number(port) + 1)
if (port === telemetryPort) throw new Error('Demo servers require separate ports')
// Check every target before starting either runtime. A second occupied port must
// never let the tests reach an unrelated service while the first server boots.
for (const target of [port, telemetryPort]) {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', () => reject(new Error('E2E port already in use')))
    probe.listen(Number(target), '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))
}

// Server-side SDK errors also terminate locally, including unexpected regressions.
const collector = createServer((_req, res) => {
  res.statusCode = 200
  res.end('{}')
})
await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
const address = collector.address()
if (!address || typeof address === 'string') throw new Error('Collector did not bind')

// Give every child only the demo harness environment. Never inherit provider credentials
// or a developer's telemetry configuration. Each SQLite/Codex home is private to its server.
const base = {
  PATH: process.env.PATH,
  HOST: '127.0.0.1',
  MAIL_REVIEW_DEMO: '1',
  NODE_ENV: 'test',
  CODEX_HOME: 'test-results/codex-home',
  DATA_DIR: 'test-results/runtime-data',
  PORT: port,
}
const children = [
  spawn(process.execPath, ['--import', './dist-server/instrument.js', 'dist-server/index.js'], {
    env: base,
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['--import', './dist-server/instrument.js', 'dist-server/index.js'], {
    env: {
      ...base,
      PORT: telemetryPort,
      CODEX_HOME: 'test-results/telemetry-codex-home',
      DATA_DIR: 'test-results/telemetry-runtime-data',
      UMAMI_URL: 'https://umami.test',
      UMAMI_WEBSITE_ID: '11111111-1111-4111-8111-111111111111',
      GLITCHTIP_DSN: `http://public@127.0.0.1:${address.port}/17`,
      GLITCHTIP_ENVIRONMENT: 'e2e',
      // Browser routes are intercepted. Disable server sampling so it makes no external calls.
      GLITCHTIP_TRACES_SAMPLE_RATE: '0',
    },
    stdio: 'inherit',
  }),
]
function stop() {
  for (const child of children) child.kill('SIGTERM')
  collector.close()
}
for (const child of children) {
  child.once('error', () => {
    process.exitCode = 1
    stop()
  })
  child.once('exit', (code) => {
    if (code) process.exitCode = code
    stop()
  })
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
