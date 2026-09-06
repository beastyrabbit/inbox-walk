import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAuthStorageBackend } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCodexAuthStorage, runCodexBundlePartition, runCodexReply } from './codex.ts'
import { withCodexRequest } from './codex-request.ts'
import { demoEmails } from './demo.ts'
import { withIoDeadline } from './io.ts'

const inference = vi.hoisted(() =>
  vi.fn<typeof import('@earendil-works/pi-coding-agent').createAgentSession>(),
)
vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...(await original<typeof import('@earendil-works/pi-coding-agent')>()),
  createAgentSession: inference,
}))

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  inference.mockReset()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  inference.mockRejectedValue(new Error('Unexpected inference blocked'))
  const directory = mkdtempSync(join(tmpdir(), 'inbox-auth-cancel-'))
  directories.push(directory)
  vi.stubEnv('DATA_DIR', directory)
  // Every provider transport and session is mocked in this test module.
  vi.stubEnv('VITEST', '')
  const storage = getCodexAuthStorage()
  storage.set('openai-codex', {
    type: 'oauth',
    access: 'synthetic-expired',
    refresh: 'synthetic-refresh',
    expires: 0,
  })
  return { storage, authPath: join(directory, 'pi', 'auth.json') }
}

describe('Codex preflight cancellation', () => {
  it('disposes a late session without inference after the HTTP deadline expires during setup', async () => {
    const { storage } = fixture()
    storage.set('openai-codex', { type: 'api_key', key: 'synthetic-api-key' })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network blocked'))
    const started = deferred()
    const release = deferred()
    const prompt = vi.fn()
    const dispose = vi.fn()
    inference.mockImplementation(async () => {
      started.resolve()
      await release.promise
      return { session: { prompt, dispose, abort: async () => {} } } as unknown as Awaited<
        ReturnType<typeof inference>
      >
    })
    const pending = withIoDeadline(
      () => runCodexReply({ images: [], prompt: 'Synthetic', systemPrompt: 'Synthetic' }),
      100,
    )
    const rejected = expect(pending).rejects.toThrow()
    await started.promise
    await rejected
    release.resolve()
    await expect.poll(() => dispose.mock.calls.length).toBe(1)
    expect(prompt).not.toHaveBeenCalled()
  })

  it.each(['headers', 'body', 'deadline'] as const)(
    'cancels stalled refresh %s and releases the file lock',
    async (phase) => {
      const { storage, authPath } = fixture()
      const started = deferred()
      let refreshSignal: AbortSignal | undefined
      let bodyCancelled = false
      const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        refreshSignal = init?.signal ?? undefined
        started.resolve()
        if (phase === 'body')
          return new Response(
            new ReadableStream({
              cancel() {
                bodyCancelled = true
              },
            }),
          )
        return await new Promise<Response>((_resolve, reject) => {
          refreshSignal?.addEventListener(
            'abort',
            () => reject(new Error('Synthetic refresh aborted')),
            { once: true },
          )
        })
      })
      const controller = new AbortController()
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      if (phase === 'deadline')
        vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
          timeout(ms === 30 * 60_000 ? 40 : ms),
        )
      const result = runCodexBundlePartition(
        { emails: [demoEmails[0]], examples: [] },
        'gpt-5.6-sol',
        'high',
        controller.signal,
      )
      const rejected = expect(result).rejects.toThrow()
      await started.promise
      if (phase !== 'deadline') controller.abort()
      await rejected
      expect(refreshSignal?.aborted).toBe(true)
      await expect.poll(() => existsSync(`${authPath}.lock`)).toBe(false)
      expect(inference).not.toHaveBeenCalled()
      if (phase === 'body') expect(bodyCancelled).toBe(true)
      expect(storage.get('openai-codex')).toMatchObject({ expires: 0 })

      const access = [
        'synthetic',
        Buffer.from(
          JSON.stringify({
            'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
          }),
        ).toString('base64url'),
        'synthetic',
      ].join('.')
      transport.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: access,
            refresh_token: 'synthetic-next',
            expires_in: 3600,
          }),
        ),
      )
      await withCodexRequest(() => storage.getApiKey('openai-codex'), 1000)
      expect(storage.get('openai-codex')).toMatchObject({
        refresh: 'synthetic-next',
        accountId: 'synthetic-account',
      })
      expect(transport).toHaveBeenCalledTimes(2)
    },
  )

  it('does not refresh or infer when cancellation happens while awaiting another auth lock', async () => {
    const { storage, authPath } = fixture()
    const backend = new FileAuthStorageBackend(authPath)
    const locked = deferred()
    const release = deferred()
    const held = backend.withLockAsync(async () => {
      locked.resolve()
      await release.promise
      return { result: undefined }
    })
    await locked.promise
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network blocked'))
    const controller = new AbortController()
    const request = withCodexRequest(
      () => storage.getApiKey('openai-codex'),
      1000,
      controller.signal,
    )
    const rejected = expect(request).rejects.toThrow()
    controller.abort()
    await rejected
    release.resolve()
    await held
    // The SDK's bounded lock retry must observe cancellation when it acquires.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(transport).not.toHaveBeenCalled()
    expect(inference).not.toHaveBeenCalled()
    expect(existsSync(`${authPath}.lock`)).toBe(false)
  })
})
