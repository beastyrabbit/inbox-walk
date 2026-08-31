import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ClientApiError } from './api.ts'
import { defaultReviewFilters, type ReviewRunSummary } from './shared.ts'

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

describe('round lifecycle API', () => {
  const run: ReviewRunSummary = {
    analysis: {
      callCount: 0,
      engine: 'codex',
      model: 'gpt-5.6-sol',
      phase: 'queued',
      processedEmailCount: 0,
      progress: 0,
      status: 'pending',
      thinkingLevel: 'high',
      totalEmailCount: 0,
    },
    createdAt: '2026-08-31T10:00:00.000Z',
    csrfToken: 'csrf-round-1',
    emailCount: 0,
    filters: defaultReviewFilters,
    generation: 1,
    id: 'round-1',
    mode: 'live',
    reanalyzable: false,
    reviewStatus: 'active',
    status: 'queued',
    updatedAt: '2026-08-31T10:00:00.000Z',
  }

  it('creates an idempotent run with the client-generated ID', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(run), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.createReview(run.id, defaultReviewFilters)).resolves.toEqual(run)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reviews',
      expect.objectContaining({
        body: JSON.stringify({ id: run.id, filters: defaultReviewFilters }),
        keepalive: true,
        method: 'POST',
      }),
    )
  })

  it('resumes a legacy stable snapshot by its exact message IDs', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const resumed = {
      csrfToken: 'csrf-migrated',
      id,
    }
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(resumed), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.resumeReview(id, ['mail-1', 'mail-2'], defaultReviewFilters)).resolves.toEqual(
      resumed,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reviews/resume',
      expect.objectContaining({
        body: JSON.stringify({
          id,
          emailIds: ['mail-1', 'mail-2'],
          filters: defaultReviewFilters,
        }),
        method: 'POST',
      }),
    )
  })

  it('lists compact runs without loading review snapshots', async () => {
    respond(JSON.stringify({ runs: [run] }))

    await expect(api.reviewRuns()).resolves.toEqual({ runs: [run] })
  })

  it('deletes a run with its CSRF token and accepts an empty 204 response', async () => {
    const fetchMock = vi.fn(async () => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.deleteReview(run)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(`/api/reviews/${run.id}`, {
      method: 'DELETE',
      headers: { 'X-Inbox-Walk-CSRF': run.csrfToken },
    })
  })

  it('starts a fresh Codex analysis for the persisted run', async () => {
    const next = {
      ...run,
      analysis: { ...run.analysis, phase: 'indexing', status: 'running' as const },
      generation: 2,
      status: 'analyzing' as const,
    }
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(next), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.reanalyzeReview(run)).resolves.toEqual(next)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/reviews/${run.id}/reanalyze`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Inbox-Walk-CSRF': run.csrfToken }),
      }),
    )
  })

  it('saves model and thinking level together', async () => {
    const settings = {
      configured: true,
      model: 'gpt-5.6-terra' as const,
      source: 'stored' as const,
      thinkingLevel: 'xhigh' as const,
    }
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(settings), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.updateCodexSettings(settings.model, settings.thinkingLevel)).resolves.toEqual(
      settings,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/codex',
      expect.objectContaining({
        body: JSON.stringify({ model: settings.model, thinkingLevel: settings.thinkingLevel }),
        method: 'PUT',
      }),
    )
  })
})
