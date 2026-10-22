import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitMainCi } from './wait-main-ci.ts'

const sha = 'a'.repeat(40)
const options = {
  repository: 'owner/repo',
  sha,
  token: 'test-token',
  timeoutMs: 100,
  intervalMs: 10,
}
const success = {
  id: 1,
  event: 'push',
  head_branch: 'main',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
}
const response = (runs: unknown[]) => Response.json({ workflow_runs: runs })

describe('exact-commit main CI gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('queries ci.yaml for push/main/exact SHA and accepts success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([success]))
    await waitMainCi({ ...options, fetcher })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(
      `https://api.github.com/repos/owner/repo/actions/workflows/ci.yaml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`,
    )
    expect(init?.redirect).toBe('error')
  })

  it.each([
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { event: 'workflow_dispatch' },
  ])('rejects mismatching run %j', async (change) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response([{ ...success, ...change }]))
    const assertion = expect(waitMainCi({ ...options, fetcher })).rejects.toThrow('Timed out')
    await vi.runAllTimersAsync()
    await assertion
  })

  it('waits for the newest pending run even when an older run succeeded', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([success, { ...success, id: 2, status: 'in_progress', conclusion: null }]),
      )
      .mockResolvedValueOnce(response([{ ...success, id: 2 }]))
    const pending = waitMainCi({ ...options, fetcher })
    await vi.runAllTimersAsync()
    await pending
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('waits for a missing run to appear', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([success]))
    const pending = waitMainCi({ ...options, fetcher })
    await vi.runAllTimersAsync()
    await pending
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', null])(
    'fails closed for newest completed run with conclusion %s',
    async (conclusion) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([{ ...success, id: 3, conclusion }, success]))
      await expect(waitMainCi({ ...options, fetcher })).rejects.toThrow('Newest main CI run 3')
    },
  )

  it.each(['missing', 'pending'])('bounds waiting for %s runs', async (state) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response(state === 'missing' ? [] : [{ ...success, status: 'queued', conclusion: null }]),
      )
    const assertion = expect(waitMainCi({ ...options, fetcher })).rejects.toThrow('Timed out')
    await vi.runAllTimersAsync()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(10)
  })

  it.each([401, 403, 500])('fails closed on API HTTP %s', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))
    await expect(waitMainCi({ ...options, fetcher })).rejects.toThrow(`HTTP ${status}`)
  })

  it('fails closed on network or malformed API responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network unavailable'))
    await expect(waitMainCi({ ...options, fetcher })).rejects.toThrow('network unavailable')
    fetcher.mockResolvedValueOnce(Response.json({}))
    await expect(waitMainCi({ ...options, fetcher })).rejects.toThrow('Malformed')
    fetcher.mockResolvedValueOnce(response([{ ...success, id: '1' }]))
    await expect(waitMainCi({ ...options, fetcher })).rejects.toThrow('Malformed')
  })
})
