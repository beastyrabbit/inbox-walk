import { expect, test } from '@playwright/test'
import type { ReviewSnapshot } from '../src/shared.ts'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Inbox Walk' })).toBeVisible()
  await page.getByRole('button', { name: 'Review starten' }).click()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
})

test('configures every new round on a dedicated direct-selection screen', async ({ page }) => {
  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await expect(page.getByRole('heading', { name: 'Inbox Walk' })).toBeVisible()
  await expect(page.locator('select')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Alles außer Spam/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByLabel('Zurückgestellte Nachrichten ausblenden')).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Runde fortsetzen' })).toBeVisible()
})

test('keeps a stable round URL across reload and the real resume action', async ({ page }) => {
  const roundUrl = page.url()
  expect(new URL(roundUrl).pathname).toMatch(/^\/rounds\/[0-9a-f-]+$/)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  expect(page.url()).toBe(roundUrl)

  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await expect(page.getByRole('button', { name: 'Runde fortsetzen' })).toBeVisible()
  await page.getByRole('button', { name: 'Runde fortsetzen' }).click()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  expect(page.url()).toBe(roundUrl)
})

test('clears an expired resume pointer instead of offering it forever', async ({ page }) => {
  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await page.evaluate(() => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({ version: 7, roundId: '00000000-0000-4000-8000-000000000000' }),
    )
  })
  await page.reload()
  await page.getByRole('button', { name: 'Runde fortsetzen' }).click()

  await expect(page.getByText('Diese Sitzung ist abgelaufen.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Runde fortsetzen' })).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')
  expect(await page.evaluate(() => localStorage.getItem('inbox-walk:checkpoint:v1'))).toBeNull()
})

test('restores persisted review decisions after reload', async ({ page }) => {
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('button', { name: 'Bleibt ungelesen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.waitForTimeout(400)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bleibt ungelesen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('stops a stale tab instead of silently losing later decisions', async ({ page }) => {
  let stateWrites = 0
  await page.route('**/api/reviews/*/state', async (route) => {
    stateWrites += 1
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'ROUND_REVISION_CONFLICT',
          message: 'Diese Runde wurde bereits in einem anderen Tab geändert. Bitte neu laden.',
          retryable: false,
        },
      }),
    })
  })
  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('heading', { name: 'Runde wurde in einem anderen Tab geändert' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Runde neu laden' })).toBeVisible()
  const writesAfterConflict = stateWrites
  await page.waitForTimeout(600)
  expect(stateWrites).toBe(writesAfterConflict)
})

test('blocks the round after a state persistence failure without retrying forever', async ({
  page,
}) => {
  let stateWrites = 0
  await page.route('**/api/reviews/*/state', async (route) => {
    stateWrites += 1
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'ROUND_PERSIST_FAILED',
          message: 'Der Rundenstand konnte nicht dauerhaft gespeichert werden.',
          retryable: true,
        },
      }),
    })
  })
  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('heading', { name: 'Rundenstand konnte nicht gespeichert werden' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Runde wurde in einem anderen Tab geändert' }),
  ).toHaveCount(0)
  const writesAfterFailure = stateWrites
  await page.waitForTimeout(600)
  expect(stateWrites).toBe(writesAfterFailure)
  expect(stateWrites).toBeLessThanOrEqual(2)
})

test('fails closed when the server acknowledges a different round state', async ({ page }) => {
  let stateWrites = 0
  await page.route('**/api/reviews/*/state', async (route) => {
    stateWrites += 1
    const request = route.request().postDataJSON() as {
      revision: number
      state: Record<string, unknown> & { index: number }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...request.state,
        index: request.state.index + 1,
        revision: request.revision + 1,
      }),
    })
  })

  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('heading', { name: 'Rundenstand konnte nicht gespeichert werden' }),
  ).toBeVisible()
  await page.waitForTimeout(600)
  expect(stateWrites).toBe(1)
})

test('shows analysis provenance and never leaves a blank root on bundle failure', async ({
  page,
}) => {
  await expect(page.getByText('Lokale Analyse', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await page.route('**/api/reviews/*/bundles', async (route) => {
    await route.fulfill({
      status: 504,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'BUNDLE_TIMEOUT',
          message: 'Die Analyse antwortet gerade nicht.',
          retryable: true,
        },
      }),
    })
  })
  await page.getByRole('button', { name: 'Review starten' }).click()
  await expect(page.getByRole('heading', { name: 'Zusammenhänge werden analysiert' })).toBeVisible()
  await expect(page.getByText('Die Runde bleibt gespeichert.')).toBeVisible()
  await expect(page.getByText('Die Analyse antwortet gerade nicht.')).toBeVisible()
  await expect(page.locator('#root')).not.toBeEmpty()
})

test('offers and applies the explicit safe view when Codex cannot resume', async ({ page }) => {
  let waiting: ReviewSnapshot | null = null
  let bundleRequests = 0
  let loginPolls = 0
  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await page.route(/\/api\/reviews\/[^/]+\/bundles$/, async (route) => {
    bundleRequests += 1
    const response = await route.fetch()
    const body = (await response.json()) as ReviewSnapshot
    waiting = {
      ...body,
      bundleRun: undefined,
      analysis: {
        ...body.analysis,
        callCount: 1,
        engine: 'codex',
        error: 'Codex muss erneut verbunden werden.',
        model: 'gpt-5.6-sol',
        phase: 'waiting_for_codex',
        status: 'pending',
      },
    }
    await route.fulfill({ response, json: waiting })
  })
  await page.route(/\/api\/reviews\/[^/]+\/bundles\/fallback$/, async (route) => {
    if (!waiting) throw new Error('Expected a waiting review snapshot')
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const fallback: ReviewSnapshot = {
      ...waiting,
      analysis: {
        ...waiting.analysis,
        engine: 'fallback',
        phase: 'complete',
        processedEmailCount: waiting.emails.length,
        progress: 1,
        status: 'complete',
        error: undefined,
      },
      bundleRun: {
        bundles: waiting.emails.map((email) => ({
          bundleId: `fallback-${email.id}`,
          currentState: 'Einzelne Nachricht',
          emailIds: [email.id],
          kind: 'standalone',
          linkEvidence: [],
          membershipConfidence: 1,
          summary: email.preview,
          timeline: [
            {
              emailId: email.id,
              event: email.subject,
              occurredAt: email.receivedAt,
              source: email.from[0]?.name || 'E-Mail',
            },
          ],
          title: email.subject,
        })),
        fallback: true,
        snapshotId: waiting.snapshotId,
      },
    }
    await route.fulfill({ status: 200, json: fallback })
  })
  await page.route('**/api/auth/codex/start', async (route) => {
    await route.fulfill({ status: 202, json: { id: 'fallback-race-login' } })
  })
  await page.route(/\/api\/auth\/codex\/fallback-race-login$/, async (route) => {
    loginPolls += 1
    await route.fulfill({
      json:
        loginPolls === 1
          ? {
              id: 'fallback-race-login',
              message: 'Warte auf Anmeldung.',
              status: 'waiting',
              url: 'https://auth.openai.com/codex/device',
              userCode: 'TEST-CODE',
            }
          : {
              id: 'fallback-race-login',
              message: 'Codex ist verbunden.',
              status: 'completed',
            },
    })
  })
  await page.route('**/api/auth/codex/status', async (route) => {
    await route.fulfill({
      json: { configured: true, model: 'gpt-5.6-sol', source: 'stored' },
    })
  })

  await page.getByRole('button', { name: 'Review starten' }).click()
  await expect(page.getByRole('heading', { name: 'Codex-Anmeldung erforderlich' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Codex wieder verbinden' })).toBeVisible()
  await page.getByRole('button', { name: 'Codex wieder verbinden' }).click()
  await page.getByRole('button', { name: 'Mit ChatGPT anmelden' }).click()
  await expect.poll(() => loginPolls).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Schließen' }).last().click()
  const bundleRequestsBeforeFallback = bundleRequests
  await page.getByRole('button', { name: 'Ohne Codex fortsetzen' }).click()
  await expect.poll(() => loginPolls, { timeout: 4_000 }).toBeGreaterThan(1)
  expect(bundleRequests).toBe(bundleRequestsBeforeFallback)
  await expect(page.locator('.analysis-badge')).toContainText('Sichere Einzelansicht')
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
})

test('names the attempted Codex model on a safe fallback result', async ({ page }) => {
  await page.route(/\/api\/reviews\/[^/]+$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        analysis: {
          ...body.analysis,
          callCount: 2,
          engine: 'fallback',
          model: 'gpt-5.6-sol',
          phase: 'complete',
          progress: 1,
          status: 'complete',
        },
      },
    })
  })
  await page.reload()
  await expect(page.locator('.analysis-badge')).toHaveText(
    'Sichere Einzelansicht · Codex-Versuch Sol · 2 Aufrufe',
  )
})

test('reviews mail with keyboard decisions and exact overview navigation', async ({ page }) => {
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('button', { name: 'Bleibt ungelesen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('heading', { name: 'Re: Essen nächste Woche?' })).toBeVisible()

  await page.getByRole('button', { name: 'Nachrichtenübersicht öffnen' }).click()
  await expect(page.getByRole('heading', { name: 'Nachrichten' })).toBeVisible()
  await page.getByRole('button', { name: /Samstagsbrief · Augustanfang/ }).click()
  await expect(page.getByRole('heading', { name: 'Samstagsbrief · Augustanfang' })).toBeVisible()
})

test('debounces typed reply state and creates a draft without a send action', async ({ page }) => {
  let stateWrites = 0
  page.on('request', (request) => {
    if (/\/api\/reviews\/[^/]+\/state$/.test(new URL(request.url()).pathname)) stateWrites += 1
  })
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('heading', { name: 'Antwortentwurf' })).toBeVisible()
  await expect(page.getByText(/Alle 1 Thread-Nachrichten/)).toBeVisible()
  await expect(page.getByRole('button', { name: /senden/i })).toHaveCount(0)

  await page
    .getByLabel('Was soll die Antwort sagen?')
    .pressSequentially('Bitte kurz bestätigen, dass ich das Ticket habe.', { delay: 10 })
  await page.getByRole('button', { name: 'Entwurf erstellen' }).click()
  await expect(page.getByRole('textbox', { name: 'Antwort', exact: true })).toHaveValue(/Ticket/)
  await page.getByRole('button', { name: 'In Fastmail als Draft speichern' }).click()
  await expect(page.getByText(/Draft gespeichert und verifiziert/)).toBeVisible()
  await page.waitForTimeout(500)
  expect(stateWrites).toBeLessThanOrEqual(3)
})

test('persists incomplete reply recipients without blocking the round', async ({ page }) => {
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  const saved = page.waitForResponse(
    (response) =>
      /\/api\/reviews\/[^/]+\/state$/.test(new URL(response.url()).pathname) &&
      Boolean(response.request().postData()?.includes('alex@')),
  )
  await page.getByRole('textbox', { name: 'An', exact: true }).fill('alex@')
  await page.getByRole('textbox', { name: 'Cc', exact: true }).fill('Team <team@')
  expect((await saved).status()).toBe(200)
  await expect(
    page.getByRole('heading', { name: 'Rundenstand konnte nicht gespeichert werden' }),
  ).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('textbox', { name: 'An', exact: true })).toHaveValue('alex@')
  await expect(page.getByRole('textbox', { name: 'Cc', exact: true })).toHaveValue('Team <team@')
})

test('flushes pending reply notes before leaving and resuming the round', async ({ page }) => {
  const notes = 'Diese noch ungespeicherten Stichpunkte müssen einen sofortigen Wechsel überleben.'
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await page.getByLabel('Was soll die Antwort sagen?').pressSequentially(notes)
  await page.getByRole('button', { name: 'Antwort schließen' }).click()
  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await expect(page.getByRole('button', { name: 'Runde fortsetzen' })).toBeVisible()
  await page.getByRole('button', { name: 'Runde fortsetzen' }).click()
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByLabel('Was soll die Antwort sagen?')).toHaveValue(notes)
})

test('requires confirmation before finalizing the fixed snapshot', async ({ page }) => {
  for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('heading', { name: 'Review abschließen?' })).toBeVisible()
  await expect(page.getByText('Bereits bearbeitet')).toBeVisible()
  await expect(page.getByText('Neue Nachrichten seit dem Start')).toBeVisible()
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(page.getByRole('heading', { name: 'Review abgeschlossen' })).toBeVisible()
})

test('can finalize only messages already confirmed with Weiter', async ({ page }) => {
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '1 bereits bearbeitete Nachrichten abschließen' }).click()

  await expect(page.getByRole('heading', { name: 'Review abschließen?' })).toBeVisible()
  await expect(
    page.locator('.review-summary div').filter({ hasText: 'Ungelesen behalten' }),
  ).toContainText('1')
  await expect(page.getByText('8 bleiben ungelesen')).toBeVisible()
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(page.getByRole('heading', { name: 'Review abgeschlossen' })).toBeVisible()
  await expect(page.getByText(/8 noch nicht bearbeitete Nachrichten/)).toBeVisible()
})

test('restores a partial finalization in the locked retry view after reload', async ({ page }) => {
  let lockedSelection:
    | {
        finalizeIds: string[]
        keepUnreadIds: string[]
        secondaryActionIds?: string[]
      }
    | undefined
  const partialResult = {
    actionFailed: [],
    failed: [{ id: 'temporary', reason: 'Fastmail hat die Änderung nicht bestätigt.' }],
    finalized: false,
    keptUnread: 0,
    markedRead: 0,
    mode: 'live',
    processed: 1,
    remaining: 1,
    rescuedFromSpam: 0,
    taggedForUnsubscribe: 0,
    untouched: 8,
  }
  await page.route(/\/api\/reviews\/[^/]+$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (!lockedSelection) {
      await route.fulfill({ response, json: body })
      return
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        finalization: { result: partialResult, selectionLocked: true, status: 'active' },
        userState: {
          ...body.userState,
          keptUnreadIds: lockedSelection.keepUnreadIds,
          processedIds: lockedSelection.finalizeIds,
          secondaryActionIds: lockedSelection.secondaryActionIds ?? [],
        },
      },
    })
  })
  await page.route('**/api/reviews/*/finalize', async (route) => {
    lockedSelection = route.request().postDataJSON() as typeof lockedSelection
    partialResult.failed[0].id = lockedSelection?.finalizeIds[0] ?? 'temporary'
    await route.fulfill({ status: 207, json: partialResult })
  })

  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '1 bereits bearbeitete Nachrichten abschließen' }).click()
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(page.getByRole('button', { name: 'Fehlgeschlagene erneut versuchen' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zurück' })).toBeDisabled()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Review abschließen?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fehlgeschlagene erneut versuchen' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zurück' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Review abschließen?' })).toBeVisible()
})

test('refreshes the durable lock after a post-lock finalization error', async ({ page }) => {
  let locked = false
  await page.route(/\/api\/reviews\/[^/]+$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: locked
        ? {
            ...body,
            finalization: { result: null, selectionLocked: true, status: 'active' },
          }
        : body,
    })
  })
  await page.route('**/api/reviews/*/finalize', async (route) => {
    locked = true
    await route.fulfill({
      status: 502,
      json: {
        error: {
          code: 'FASTMAIL_TEMPORARY_FAILURE',
          message: 'Fastmail hat nach dem Lock nicht geantwortet.',
          retryable: true,
        },
      },
    })
  })

  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '1 bereits bearbeitete Nachrichten abschließen' }).click()
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(page.getByRole('heading', { name: 'Review abschließen?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zurück' })).toBeDisabled()
  await expect(page.getByText('Fastmail hat nach dem Lock nicht geantwortet.')).toBeVisible()
})

test('does not leave confirmation with Escape while finalization is in flight', async ({
  page,
}) => {
  let releaseFinalize: (() => void) | undefined
  const finalizeGate = new Promise<void>((resolve) => {
    releaseFinalize = resolve
  })
  await page.route('**/api/reviews/*/finalize', async (route) => {
    await finalizeGate
    const selection = route.request().postDataJSON() as { finalizeIds: string[] }
    await route.fulfill({
      status: 207,
      json: {
        actionFailed: [],
        failed: [
          {
            id: selection.finalizeIds[0],
            reason: 'Fastmail hat die Änderung nicht bestätigt.',
          },
        ],
        finalized: false,
        keptUnread: 0,
        markedRead: 0,
        mode: 'live',
        processed: selection.finalizeIds.length,
        remaining: 1,
        rescuedFromSpam: 0,
        taggedForUnsubscribe: 0,
        untouched: 8,
      },
    })
  })

  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '1 bereits bearbeitete Nachrichten abschließen' }).click()
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(page.getByRole('button', { name: 'Wird gespeichert …' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Review abschließen?' })).toBeVisible()
  releaseFinalize?.()
  await expect(page.getByRole('button', { name: 'Fehlgeschlagene erneut versuchen' })).toBeVisible()
})

test('bundles connected GitHub and Railway notifications and keeps originals inspectable', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Nachrichtenübersicht öffnen' }).click()
  await page.getByRole('button', { name: /Railway deployment successful/ }).click()
  await expect(page.getByText('GitHub · Railway')).toBeVisible()
  await expect(
    page.getByRole('list', { name: 'Verlauf der Story' }).getByRole('button'),
  ).toHaveCount(4)
  await page
    .getByRole('button', { name: /GitHub · \[beasty\/inbox-walk\] Pull request #184 opened/ })
    .click()
  await expect(page.locator('.original-subject')).toHaveText(/Pull request #184 opened/)
  await page.getByRole('button', { name: 'Ausgewähltes Original lösen' }).click()
  await expect(page.getByText('3 Originale')).toBeVisible()
})

test('completes every bundle member while protecting one selected original', async ({ page }) => {
  await page.getByRole('button', { name: 'Nachrichtenübersicht öffnen' }).click()
  await page.getByRole('button', { name: /Railway deployment successful/ }).click()
  await page
    .getByRole('button', { name: /GitHub · \[beasty\/inbox-walk\] Pull request #184 opened/ })
    .click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '4 bereits bearbeitete Nachrichten abschließen' }).click()
  await expect(
    page.locator('.review-summary div').filter({ hasText: 'Bereits bearbeitet' }),
  ).toContainText('4')
  await expect(
    page.locator('.review-summary div').filter({ hasText: 'Als gelesen markieren' }),
  ).toContainText('3')
  await expect(
    page.locator('.review-summary div').filter({ hasText: 'Ungelesen behalten' }),
  ).toContainText('1')
})

test('opens keyboard help and closes it with Escape', async ({ page }) => {
  await page.keyboard.press('?')
  await expect(page.getByRole('heading', { name: 'Tastatur' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Tastatur' })).toBeHidden()
})

test('selects the Codex model from the connection dialog', async ({ page }) => {
  await page.route('**/api/review/options', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      json: {
        ...body,
        codex: { configured: true, model: 'gpt-5.6-sol', source: 'stored' },
        mode: 'live',
      },
    })
  })
  await page.route('**/api/reviews', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ json: { ...body, mode: 'live' } })
  })
  await page.route(/\/api\/reviews\/[^/]+$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ json: { ...body, mode: 'live' } })
  })
  await page.route('**/api/auth/codex/model', async (route) => {
    const request = route.request().postDataJSON() as { model: string }
    await route.fulfill({
      json: { configured: true, model: request.model, source: 'stored' },
    })
  })

  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.getByRole('button', { name: 'Codex einstellen' }).click()

  await expect(page.getByRole('heading', { name: 'Codex einrichten' })).toBeVisible()
  await expect(page.getByLabel('Sol')).toBeChecked()
  await page.getByLabel('Terra').check()
  await page.getByRole('button', { name: 'Modell speichern' }).click()
  await expect(page.getByLabel('Terra')).toBeChecked()
  await expect(page.getByRole('button', { name: 'Modell speichern' })).toBeDisabled()
})

test('keeps mail scripts blocked while allowing authenticated same-origin images', async ({
  page,
}) => {
  const frame = page.locator('iframe.message-body')
  await expect(frame).toHaveAttribute('sandbox', /allow-same-origin/)
  await expect(frame).not.toHaveAttribute('sandbox', /allow-scripts/)
})

test('marks newsletters for deferred unsubscribe work', async ({ page }) => {
  await page.getByRole('button', { name: 'Nachrichtenübersicht öffnen' }).click()
  await page.getByRole('button', { name: /Samstagsbrief · Augustanfang/ }).click()
  const action = page.getByRole('button', { name: 'Für spätere Abmeldung markieren' })
  await expect(action).toBeEnabled()
  await action.click()
  await expect(page.getByRole('button', { name: 'Abmelde-Label vorgemerkt' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('reviews Spam separately and makes Down mean Not Spam', async ({ page }) => {
  await page.getByRole('button', { name: 'Neue Auswahl' }).click()
  await page.getByRole('button', { name: /Nur Spam/ }).click()
  await page.getByRole('button', { name: 'Review starten' }).click()

  await expect(page.getByRole('heading', { name: 'Falsch einsortierte Nachricht' })).toBeVisible()
  const action = page.getByRole('button', { name: 'Kein Spam', exact: true })
  await action.click()
  await expect(page.getByRole('button', { name: 'Als kein Spam vorgemerkt' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('ArrowRight')
  await expect(page.getByText('Aus Spam in die Inbox')).toBeVisible()
  await expect(page.locator('.review-summary div').filter({ hasText: 'Aus Spam' })).toContainText(
    '1',
  )
})
