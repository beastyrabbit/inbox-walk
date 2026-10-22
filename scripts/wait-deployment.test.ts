import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitDeployment } from './wait-deployment.ts'

const expected = 'inbox-walk@0.12.1'
const options = { expected, timeoutMs: 100, reachabilityMs: 30, intervalMs: 10 }
const config = (release = expected) => Response.json({ release })
const html = () =>
  new Response('<!doctype html><html><div id="root"></div></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
const health = () => Response.json({ status: 'ok' })

describe('Flux rollout smoke', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits for the exact release then GETs application HTML and health', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config('inbox-walk@0.12.0'))
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(html())
      .mockResolvedValueOnce(health())
    const pending = waitDeployment({ ...options, fetcher })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe('deployed')
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/client-config',
      '/api/client-config',
      '/',
      '/healthz',
    ])
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('http://inbox-walk.tools.svc.cluster.local:3000')
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it.each(['0.12.2', '0.13.0', '1.0.0', '0.12.10', '0.13.0-rc.1'])(
    'reports newer %s as superseded without claiming a smoke passed',
    async (version) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(config(`inbox-walk@${version}`))
      await expect(waitDeployment({ ...options, fetcher })).resolves.toBe('superseded')
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('compares prereleases numerically and treats stable as newer', async () => {
    for (const actual of ['inbox-walk@1.0.0-rc.10', 'inbox-walk@1.0.0']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(config(actual))
      await expect(
        waitDeployment({ ...options, expected: 'inbox-walk@1.0.0-rc.2', fetcher }),
      ).resolves.toBe('superseded')
    }
  })

  it.each(['inbox-walk@0.12.0', 'inbox-walk@0.12.1-rc.1', 'inbox-walk@0.12.1+other'])(
    'times out when exact release never appears: %s',
    async (release) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => config(release))
      const assertion = expect(waitDeployment({ ...options, fetcher })).rejects.toThrow('Timed out')
      await vi.runAllTimersAsync()
      await assertion
      expect(fetcher).toHaveBeenCalledTimes(10)
    },
  )

  it('checks runner reachability with a short deadline', async () => {
    const start = Date.now()
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const assertion = expect(waitDeployment({ ...options, fetcher })).rejects.toThrow('unreachable')
    await vi.runAllTimersAsync()
    await assertion
    expect(Date.now() - start).toBe(30)
  })

  it('retries transport failures and rollout 503s before succeeding', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(html())
      .mockResolvedValueOnce(health())
    const pending = waitDeployment({ ...options, fetcher })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe('deployed')
  })

  it.each(['/api/client-config', '/', '/healthz'])('rejects redirects at %s', async (path) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const pathname = new URL(String(url)).pathname
      if (pathname === path)
        return new Response('', { status: 302, headers: { location: '/login' } })
      return pathname === '/api/client-config' ? config() : html()
    })
    await expect(waitDeployment({ ...options, fetcher })).rejects.toThrow('HTTP 302')
  })

  it.each([
    Response.json({}),
    config('other-app@0.12.1'),
    config('inbox-walk@garbage'),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response('SSO login', { headers: { 'content-type': 'text/html' } }),
    new Response('', { status: 401 }),
  ])('rejects malformed config or unexpected responses %#', async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(waitDeployment({ ...options, fetcher })).rejects.toThrow()
  })

  it.each(['html', 'health'])('rejects malformed %s after version match', async (invalid) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(
        invalid === 'html'
          ? new Response('login', {
              headers: { 'content-type': 'text/html' },
            })
          : html(),
      )
      .mockResolvedValueOnce(Response.json({ status: 'failed' }))
    await expect(waitDeployment({ ...options, fetcher })).rejects.toThrow('Malformed')
  })
})
