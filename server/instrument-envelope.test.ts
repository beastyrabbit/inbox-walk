import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['captured exception', 'unhandled rejection'])(
  'the real Node preload reports a scrubbed %s to a local collector',
  async (scenario) => {
    const bodies: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        bodies.push(body)
        res.end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Local collector did not bind')
      const result = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            fileURLToPath(new URL('./instrument.ts', import.meta.url)),
            '--input-type=module',
            '-e',
            scenario === 'unhandled rejection'
              ? `Promise.reject(new Error('Private subject alex@example.com Mf1a2b3c4d5e6f preview'));
               setTimeout(() => process.exit(0), 3000);`
              : `const Sentry = await import('@sentry/node');
         Sentry.captureException(new Error('Private subject alex@example.com Mf1a2b3c4d5e6f preview'), {
           extra: { body: 'Private message body', notes: 'Private memory notes' },
           user: { email: 'alex@example.com' }
         });
         await Sentry.flush(2000);`,
          ],
          {
            env: {
              PATH: process.env.PATH,
              NODE_ENV: 'test',
              MAIL_REVIEW_DEMO: '1',
              GLITCHTIP_DSN: `http://public@127.0.0.1:${address.port}/17`,
              GLITCHTIP_ENVIRONMENT: 'test',
              GLITCHTIP_TRACES_SAMPLE_RATE: '0',
            },
            stdio: ['ignore', 'ignore', 'ignore'],
          },
        )
        child.once('error', reject)
        child.once('exit', resolve)
      })
      expect(result).toBe(scenario === 'unhandled rejection' ? 1 : 0)
      expect(bodies).toHaveLength(1)
      const body = bodies.join('')
      expect(body).toContain('"release":"inbox-walk@0.12.0"')
      expect(body).toContain('"environment":"test"')
      expect(body).toContain('Application error (details withheld)')
      if (scenario === 'unhandled rejection') {
        expect(body).toContain('"level":"fatal"')
        expect(body).toContain('"handled":false')
      }
      for (const secret of [
        'Private subject',
        'alex@example.com',
        'Mf1a2b3c4d5e6f',
        'Private message body',
        'Private memory notes',
      ])
        expect(body).not.toContain(secret)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
