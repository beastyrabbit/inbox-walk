import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type OAuthCredentials,
  openaiCodexOAuthProvider,
  registerOAuthProvider,
} from '@earendil-works/pi-ai/oauth'
import { AuthStorage, FileAuthStorageBackend } from '@earendil-works/pi-coding-agent'
import { abortable, ioSignal, readBoundedBody } from './io.ts'

const requestSignal = new AsyncLocalStorage<AbortSignal>()

export function codexRequestSignal() {
  const signal = requestSignal.getStore()
  if (!signal) throw new Error('Codex work requires an operation deadline.')
  return signal
}

export function withCodexRequest<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const combined = ioSignal(timeoutMs, signal)
  combined.throwIfAborted()
  return requestSignal.run(combined, () => abortable(work(), combined))
}

// Pi 0.80.7 does not pass cancellation to token refresh. Keep its login,
// credential persistence and locking, replacing only the refresh transport.
export async function refreshCodexCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const signal = ioSignal(30_000, codexRequestSignal())
  signal.throwIfAborted()
  const response = await abortable(
    fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refresh,
        // Public OAuth client identifier used by the installed Pi adapter.
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      }),
      signal,
    }),
    signal,
  )
  const body = await readBoundedBody(response, 64 * 1024, signal)
  if (!response.ok) throw new Error(`Codex OAuth refresh failed (HTTP ${response.status}).`)
  // Never include token responses in errors or logs.
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (
      typeof value.access_token !== 'string' ||
      !value.access_token ||
      typeof value.refresh_token !== 'string' ||
      !value.refresh_token ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    )
      throw new Error()
    const parts = value.access_token.split('.')
    if (parts.length !== 3) throw new Error()
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId) throw new Error()
    signal.throwIfAborted()
    return {
      access: value.access_token,
      refresh: value.refresh_token,
      expires: Date.now() + value.expires_in * 1000,
      accountId,
    }
  } catch {
    signal.throwIfAborted()
    throw new Error('Codex OAuth refresh returned invalid credentials.')
  }
}

export function createCodexAuthStorage(authPath: string) {
  registerOAuthProvider({ ...openaiCodexOAuthProvider, refreshToken: refreshCodexCredentials })
  const backend = new FileAuthStorageBackend(authPath)
  return AuthStorage.fromStorage({
    withLock: (work) => backend.withLock(work),
    withLockAsync: (work) => {
      const signal = codexRequestSignal()
      signal.throwIfAborted()
      return abortable(
        backend.withLockAsync(async (current) => {
          // Pi's bounded lock retry can finish after cancellation. Do no work then.
          signal.throwIfAborted()
          const result = await abortable(work(current), signal)
          signal.throwIfAborted()
          return result
        }),
        signal,
      )
    },
  })
}
