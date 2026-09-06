import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

let posts = 0
const stub = createServer((req, res) => {
  if (req.method === 'POST') posts += 1
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ mode: 'live' }))
})
await new Promise<void>((resolve, reject) => {
  stub.once('error', reject)
  stub.listen(0, '127.0.0.1', resolve)
})
try {
  const address = stub.address()
  if (!address || typeof address === 'string') throw new Error('Stub failed to bind')
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'playwright', 'test', '--project=chromium', '--grep=shows the package version'],
      {
        env: {
          PATH: process.env.PATH,
          CI: '1',
          MAIL_REVIEW_DEMO: '1',
          MAIL_REVIEW_TEST_PORT: String(address.port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, output }))
  })
  assert.notEqual(result.code, 0, 'The harness must reject an occupied port')
  assert.match(result.output, /already used|already in use/i)
  assert.equal(posts, 0, 'No mutation may reach the pre-existing server')
  console.log('Occupied-port browser isolation passed with zero POST requests.')
} finally {
  await new Promise<void>((resolve) => stub.close(() => resolve()))
}
