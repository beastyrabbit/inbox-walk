import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ClientApiError } from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function respond(body: string, status = 200, contentType = 'application/json') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(body, {
          status,
          headers: { 'Content-Type': contentType },
        }),
      ),
    ),
  )
}

describe('API response handling', () => {
  it('returns a normal JSON response', async () => {
    respond('{"id":"login-1"}')

    await expect(api.startCodexLogin()).resolves.toEqual({ id: 'login-1' })
  })

  it('preserves structured JSON API errors', async () => {
    respond(
      JSON.stringify({
        error: {
          code: 'ROUND_NOT_FOUND',
          message: 'Diese Runde wurde nicht gefunden.',
          retryable: false,
          details: { roundId: 'round-1' },
        },
      }),
      404,
    )

    await expect(api.review('round-1')).rejects.toMatchObject({
      name: 'Error',
      message: 'Diese Runde wurde nicht gefunden.',
      code: 'ROUND_NOT_FOUND',
      retryable: false,
      details: { roundId: 'round-1' },
      status: 404,
    })
  })

  it('turns a plain-text Bad Gateway response into a retryable client error', async () => {
    respond('Bad Gateway', 502, 'text/plain')

    const request = api.startCodexLogin()
    await expect(request).rejects.toBeInstanceOf(ClientApiError)
    await expect(request).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
      status: 502,
    })
    await expect(request).rejects.not.toMatchObject({
      message: expect.stringContaining('Bad Gateway'),
    })
  })

  it('does not expose an HTML gateway response', async () => {
    respond('<html><body>upstream details</body></html>', 502, 'text/html')

    const request = api.startCodexLogin()
    await expect(request).rejects.toMatchObject({
      message: 'Der Server ist vorübergehend nicht erreichbar. Bitte versuche es gleich erneut.',
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
      status: 502,
    })
    await expect(request).rejects.not.toMatchObject({
      message: expect.stringContaining('upstream details'),
    })
  })

  it.each([
    { status: 200, retryable: false },
    { status: 500, retryable: true },
  ])('reports malformed JSON with status $status safely', async ({ retryable, status }) => {
    respond('{not-json', status)

    await expect(api.startCodexLogin()).rejects.toMatchObject({
      message: 'Der Server hat eine ungültige Antwort geliefert.',
      code: 'INVALID_RESPONSE',
      retryable,
      status,
    })
  })

  it('turns a fetch failure into a retryable client error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    )

    await expect(api.startCodexLogin()).rejects.toMatchObject({
      message:
        'Der Server ist nicht erreichbar. Bitte überprüfe deine Verbindung und versuche es erneut.',
      code: 'NETWORK_ERROR',
      retryable: true,
    })
  })
})
