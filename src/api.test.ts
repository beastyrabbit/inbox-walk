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
          code: 'EMAIL_NOT_FOUND',
          message: 'Nachricht nicht gefunden.',
          retryable: false,
          details: { emailId: 'mail-1' },
        },
      }),
      404,
    )

    await expect(api.email('mail-1')).rejects.toMatchObject({
      name: 'Error',
      message: 'Nachricht nicht gefunden.',
      code: 'EMAIL_NOT_FOUND',
      retryable: false,
      details: { emailId: 'mail-1' },
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

describe('todo API', () => {
  it('sends message actions with the CSRF token and keeps them alive on unload', async () => {
    const result = { failed: [], snapshot: { buckets: [] } }
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.messageAction('done', ['mail-1'], 'csrf-1')).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/todo/messages/done',
      expect.objectContaining({
        body: JSON.stringify({ emailIds: ['mail-1'] }),
        headers: expect.objectContaining({ 'X-Inbox-Walk-CSRF': 'csrf-1' }),
        keepalive: true,
        method: 'POST',
      }),
    )
  })

  it('accepts a multi-status action result with failures', async () => {
    const result = { failed: [{ id: 'mail-2', reason: 'Fastmail-Fehler' }], snapshot: {} }
    respond(JSON.stringify(result), 207)

    await expect(api.messageAction('done', ['mail-1', 'mail-2'], 'csrf-1')).resolves.toEqual(result)
  })

  it('saves memory notes with PUT', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ notes: 'Notiz', proposals: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.saveMemory('Notiz', 'csrf-1')).resolves.toEqual({
      notes: 'Notiz',
      proposals: [],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/todo/memory',
      expect.objectContaining({ body: JSON.stringify({ notes: 'Notiz' }), method: 'PUT' }),
    )
  })
})
