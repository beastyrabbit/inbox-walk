import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import type { ReviewRunSummary } from '../src/shared.ts'

const { version: appVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

async function startAndOpenRound(page: Page) {
  await page.getByRole('button', { name: 'Runde starten' }).click()
  const open = page.getByRole('button', { name: 'Runde öffnen' }).first()
  await expect(open).toBeEnabled({ timeout: 15_000 })
  await open.click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Inbox Walk' })).toBeVisible()
  await startAndOpenRound(page)
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
})

test('configures every new round on a dedicated direct-selection screen', async ({ page }) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  await expect(page.getByRole('heading', { name: 'Inbox Walk' })).toBeVisible()
  await expect(page.locator('select')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Alles außer Spam/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByLabel('Zurückgestellte Nachrichten ausblenden')).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Runde öffnen' }).first()).toBeEnabled()
})

test('shows the package version beside the product name', async ({ page }) => {
  const visibleVersion = `v${appVersion}`
  const overviewButton = page.getByRole('button', {
    name: `Nachrichtenübersicht öffnen · Inbox Walk ${visibleVersion}`,
  })

  await expect(overviewButton.getByText(visibleVersion, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.getByRole('button', { name: 'Runden' }).click()
  const productHeading = page.getByRole('heading', {
    name: `Inbox Walk ${visibleVersion}`,
    exact: true,
  })
  await expect(productHeading).toBeVisible()
  await expect(productHeading.getByText(visibleVersion, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('keeps the overview visible and shows the new run before processing starts', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  const rows = page.locator('.runs-table tbody tr')
  const countBefore = await rows.count()
  let releaseCreate = () => undefined
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() === 'POST') {
      await createGate
    }
    await route.continue()
  })

  try {
    await page.getByRole('button', { name: 'Runde starten' }).click()
    const run = rows.first()
    await expect(rows).toHaveCount(countBefore + 1)
    await expect(page.getByRole('heading', { name: 'Runden' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
    await expect(run).toHaveAttribute('data-status', 'queued')
    await expect(run.getByRole('button', { name: 'Runde öffnen' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Runde wird angelegt …' })).toBeDisabled()

    await page.waitForTimeout(1_100)
    await expect(rows).toHaveCount(countBefore + 1)
    const runBox = await run.boundingBox()
    const viewport = page.viewportSize()
    expect(runBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    if (runBox && viewport) {
      expect(runBox.y).toBeGreaterThanOrEqual(0)
      expect(runBox.y).toBeLessThan(viewport.height)
    }

    releaseCreate()
    await expect(run.getByRole('button', { name: 'Runde öffnen' })).toBeEnabled({
      timeout: 15_000,
    })
  } finally {
    releaseCreate()
    await page.unroute('**/api/reviews')
  }
})

test('recovers a persisted run after its create response and first status check are lost', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  let dropStatusChecks = true
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fetch()
      await route.abort('connectionfailed')
      return
    }
    if (dropStatusChecks) {
      await route.abort('connectionfailed')
      return
    }
    await route.continue()
  })

  try {
    await page.getByRole('button', { name: 'Runde starten' }).click()
    const run = page.locator('.runs-table tbody tr').first()
    await expect(run).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(
      'Der Rundenstatus wird automatisch erneut abgeglichen.',
    )
    dropStatusChecks = false
    await expect(run.getByRole('button', { name: 'Runde öffnen' })).toBeEnabled({
      timeout: 15_000,
    })
  } finally {
    dropStatusChecks = false
    await page.unroute('**/api/reviews')
  }
})

test('refreshes a stale ready row when another tab has already restarted the analysis', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  await page.route(/\/api\/reviews\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'ROUND_NOT_READY',
          message: 'Diese Runde wird noch analysiert.',
          retryable: true,
        },
      },
    })
  })
  await page.route('**/api/reviews', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { runs: ReviewRunSummary[] }
    const [latest, ...rest] = body.runs
    await route.fulfill({
      response,
      json: {
        runs: latest
          ? [
              {
                ...latest,
                analysis: {
                  ...latest.analysis,
                  phase: 'deciding',
                  status: 'running',
                },
                reanalyzable: false,
                status: 'analyzing',
              },
              ...rest,
            ]
          : rest,
      },
    })
  })

  const run = page.locator('.runs-table tbody tr').first()
  await run.getByRole('button', { name: 'Runde öffnen' }).click()
  await expect(run).toHaveAttribute('data-status', 'analyzing')
  await expect(run.getByRole('button', { name: 'Runde öffnen' })).toBeDisabled()
  expect(new URL(page.url()).pathname).toBe('/')
})

test('does not keep the previous review visible after invalid browser history navigation', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  await page.evaluate(() => {
    window.history.pushState({}, '', '/rounds/deleted-round')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  await expect(page.getByRole('heading', { name: 'Runden' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')
})

test('reanalyzes the same run and gates opening until the new result is ready', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  const run = page.locator('.runs-table tbody tr').first()
  await run.getByRole('button', { name: 'Mit Codex neu analysieren' }).click()
  await expect(run).toHaveAttribute('data-status', 'analyzing')
  await expect(run.getByRole('button', { name: 'Runde öffnen' })).toBeDisabled()
  await expect(run.getByRole('button', { name: 'Runde öffnen' })).toBeEnabled({ timeout: 15_000 })
})

test('shows concrete Codex call progress while a large round is still analyzing', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  await page.route('**/api/reviews', async (route) => {
    const response = await route.fetch()
    if (route.request().method() !== 'GET') {
      await route.fulfill({ response })
      return
    }
    const body = (await response.json()) as { runs: ReviewRunSummary[] }
    const [latest, ...rest] = body.runs
    await route.fulfill({
      response,
      json: {
        runs: latest
          ? [
              {
                ...latest,
                analysis: {
                  ...latest.analysis,
                  callCount: 3,
                  phase: 'deciding',
                  processedEmailCount: 0,
                  progress: 0,
                  status: 'running',
                  totalEmailCount: 379,
                },
                reanalyzable: false,
                status: 'analyzing',
              },
              ...rest,
            ]
          : rest,
      },
    })
  })

  await page.reload()
  await expect(
    page.getByText(
      /Codex analysiert alle Nachrichten gemeinsam · 379 Nachrichten · 3 Codex-Aufrufe/,
    ),
  ).toBeVisible()
})

test('keeps a stable round URL across reload and reopening from the overview', async ({ page }) => {
  const roundUrl = page.url()
  expect(new URL(roundUrl).pathname).toMatch(/^\/rounds\/[0-9a-f-]+$/)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  expect(page.url()).toBe(roundUrl)

  await page.getByRole('button', { name: 'Runden' }).click()
  await expect(page.getByRole('button', { name: 'Runde öffnen' }).first()).toBeEnabled()
  await page.getByRole('button', { name: 'Runde öffnen' }).first().click()
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
  expect(page.url()).toBe(roundUrl)
})

test('deletes a persisted round from the overview', async ({ page }) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  const row = page.getByRole('row').filter({ hasText: 'Bereit' }).first()
  const roundLabel = await row.locator('strong').first().innerText()
  await row.getByRole('button', { name: /löschen/ }).click()
  await expect(page.getByRole('heading', { name: 'Runde löschen?' })).toBeVisible()
  await page.getByRole('button', { name: 'Runde löschen', exact: true }).click()
  await expect(page.getByText(roundLabel, { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(roundLabel, { exact: true })).toHaveCount(0)
})

test('stops polling after deleting the currently staged legacy migration run', async ({ page }) => {
  let migrationId = ''
  let listRequests = 0
  await page.route('**/api/reviews/resume', async (route) => {
    const request = route.request().postDataJSON() as { id: string }
    const response = await route.fetch()
    const body = (await response.json()) as { id: string }
    migrationId = request.id
    expect(body.id).toBe(migrationId)
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    listRequests += 1
    const response = await route.fetch()
    const body = (await response.json()) as { runs: ReviewRunSummary[] }
    await route.fulfill({
      response,
      json: {
        runs: body.runs.map((run) =>
          run.id === migrationId
            ? {
                ...run,
                analysis: { ...run.analysis, phase: 'deciding', status: 'running' },
                reanalyzable: false,
                status: 'analyzing',
              }
            : run,
        ),
      },
    })
  })
  await page.evaluate(() => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        version: 6,
        bundleGroups: [['demo-human']],
        emailIds: ['demo-human'],
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        index: 0,
        keptUnreadIds: [],
        processedIds: [],
        secondaryActionIds: [],
        replyDrafts: {},
      }),
    )
  })

  await page.goto('/')
  await expect.poll(() => migrationId).not.toBe('')
  const row = page.locator(`#run-${migrationId}`)
  await expect(row).toHaveAttribute('data-status', 'analyzing')
  await row.getByRole('button', { name: /löschen/ }).click()
  await page.getByRole('button', { name: 'Runde löschen', exact: true }).click()
  await expect(row).toHaveCount(0)

  const checkpoint = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('inbox-walk:checkpoint:v1') ?? 'null'),
  )
  expect(checkpoint).toMatchObject({ version: 6, migrationRoundId: migrationId })

  await page.waitForTimeout(2_200)
  const settledRequests = listRequests
  await page.waitForTimeout(1_300)
  expect(listRequests).toBe(settledRequests)
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

test('migrates a legacy round once, including its reply draft, then keeps only the round ID', async ({
  page,
}) => {
  const draftBody = 'Eigener Legacy-Entwurf, der vollständig erhalten bleiben muss.'
  await page.evaluate((bodyText) => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        version: 6,
        bundleGroups: [['demo-human']],
        emailIds: ['demo-human'],
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        index: 0,
        keptUnreadIds: ['demo-human'],
        processedIds: ['demo-human'],
        secondaryActionIds: [],
        replyDrafts: {
          'demo-human': {
            bodyText,
            cc: [],
            identityId: 'demo-identity',
            revisionInstruction: '',
            roughNotes: 'Bitte freundlich lassen.',
            subject: 'Re: Essen nächste Woche?',
            to: [{ email: 'mara@example.com', name: 'Mara' }],
          },
        },
      }),
    )
  }, draftBody)

  const resumed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/reviews/resume' &&
      response.request().method() === 'POST',
  )
  await page.goto('/')
  const response = await resumed
  expect(response.status()).toBe(202)
  const { id: snapshotId } = (await response.json()) as { id: string }

  await expect(page.getByRole('heading', { name: 'Re: Essen nächste Woche?' })).toBeVisible({
    timeout: 15_000,
  })
  expect(new URL(page.url()).pathname).toBe(`/rounds/${snapshotId}`)
  await expect(page.getByRole('button', { name: 'Bleibt ungelesen', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('textbox', { name: 'Antwort', exact: true })).toHaveValue(draftBody)

  const checkpoint = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('inbox-walk:checkpoint:v1') ?? 'null'),
  )
  expect(checkpoint).toEqual({ version: 7, roundId: snapshotId })
  expect(JSON.stringify(checkpoint)).not.toContain(draftBody)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Re: Essen nächste Woche?' })).toBeVisible()
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('textbox', { name: 'Antwort', exact: true })).toHaveValue(draftBody)
})

test('reuses the staged legacy round after its first response is lost and the page reloads', async ({
  page,
}) => {
  const resumeIds: string[] = []
  await page.route('**/api/reviews/resume', async (route) => {
    const body = route.request().postDataJSON() as { id: string }
    resumeIds.push(body.id)
    const response = await route.fetch()
    if (resumeIds.length === 1) {
      await route.abort('connectionfailed')
      return
    }
    await route.fulfill({ response })
  })
  await page.evaluate(() => {
    localStorage.setItem(
      'inbox-walk:checkpoint:v1',
      JSON.stringify({
        version: 6,
        bundleGroups: [['demo-human']],
        emailIds: ['demo-human'],
        filters: {
          hideReviewed: false,
          mailboxId: null,
          newsletter: 'all',
          spam: 'exclude',
          timeRange: 'all',
        },
        index: 0,
        keptUnreadIds: [],
        processedIds: [],
        secondaryActionIds: [],
        replyDrafts: {},
      }),
    )
  })

  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText(
    'Der alte Rundenstand konnte nicht übertragen werden.',
  )
  expect(resumeIds).toHaveLength(1)
  const migrationId = resumeIds[0]
  expect(migrationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('inbox-walk:checkpoint:v1') ?? 'null')),
    )
    .toMatchObject({ version: 6, migrationRoundId: migrationId })

  const runsAfterLostResponse = await page.evaluate(async () => {
    const response = await fetch('/api/reviews')
    return (await response.json()) as { runs: Array<{ id: string }> }
  })
  expect(runsAfterLostResponse.runs.filter((run) => run.id === migrationId)).toHaveLength(1)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Re: Essen nächste Woche?' })).toBeVisible({
    timeout: 15_000,
  })
  expect(new URL(page.url()).pathname).toBe(`/rounds/${migrationId}`)
  expect(resumeIds).toEqual([migrationId])
  const checkpoint = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('inbox-walk:checkpoint:v1') ?? 'null'),
  )
  expect(checkpoint).toEqual({ version: 7, roundId: migrationId })
})

test('shows an invalid legacy checkpoint without deleting its draft state', async ({ page }) => {
  const invalid = JSON.stringify({
    version: 6,
    emailIds: ['demo-human'],
    replyDrafts: { 'demo-human': { bodyText: 'Nicht stillschweigend löschen' } },
  })
  await page.evaluate((raw) => {
    localStorage.setItem('inbox-walk:checkpoint:v1', raw)
  }, invalid)

  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText(
    'Der gespeicherte alte Rundenstand ist ungültig und wurde nicht gelöscht.',
  )
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('inbox-walk:checkpoint:v1')))
    .toBe(invalid)
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

test('keeps a failed analysis in the rounds table with recovery actions', async ({ page }) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  let forceFailure = false
  await page.route('**/api/reviews', async (route) => {
    const response = await route.fetch()
    if (route.request().method() !== 'GET' || !forceFailure) {
      await route.fulfill({ response })
      return
    }
    const body = (await response.json()) as { runs: ReviewRunSummary[] }
    const [latest, ...rest] = body.runs
    await route.fulfill({
      response,
      json: {
        runs: latest
          ? [
              {
                ...latest,
                analysis: {
                  ...latest.analysis,
                  error: 'Codex muss erneut verbunden werden.',
                  phase: 'failed',
                  status: 'pending',
                },
                reanalyzable: true,
                status: 'failed',
              },
              ...rest,
            ]
          : rest,
      },
    })
  })
  await page.getByRole('button', { name: 'Runde starten' }).click()
  forceFailure = true
  await expect(page.getByText('Codex muss erneut verbunden werden.')).toBeVisible({
    timeout: 5_000,
  })
  const failed = page.getByRole('row').filter({ hasText: 'Fehlgeschlagen' }).first()
  await expect(failed.getByRole('button', { name: 'Runde öffnen' })).toBeDisabled()
  await expect(failed.getByRole('button', { name: 'Mit Codex neu analysieren' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Ohne Codex fortsetzen' })).toHaveCount(0)
})

test('uses the backend capability flag to disable Codex reanalysis', async ({ page }) => {
  await page.getByRole('button', { name: 'Runden' }).click()
  await page.route('**/api/reviews', async (route) => {
    const response = await route.fetch()
    if (route.request().method() !== 'GET') {
      await route.fulfill({ response })
      return
    }
    const body = (await response.json()) as { runs: ReviewRunSummary[] }
    const [latest, ...rest] = body.runs
    await route.fulfill({
      response,
      json: {
        runs: latest
          ? [
              {
                ...latest,
                analysis: {
                  ...latest.analysis,
                  error: 'Postfach konnte nicht geladen werden.',
                  phase: 'failed',
                  processedEmailCount: 0,
                  progress: 0,
                  status: 'pending',
                  totalEmailCount: 0,
                },
                emailCount: 1,
                reanalyzable: false,
                status: 'failed',
              },
              ...rest,
            ]
          : rest,
      },
    })
  })

  await page.reload()
  const failed = page.getByRole('row').filter({ hasText: 'Postfach konnte nicht geladen werden.' })
  await expect(failed.getByRole('button', { name: 'Mit Codex neu analysieren' })).toBeDisabled()
})

test('does not offer deletion while a round is being finalized', async ({ page }) => {
  await page.route('**/api/reviews', async (route) => {
    const response = await route.fetch()
    if (route.request().method() !== 'GET') {
      await route.fulfill({ response })
      return
    }
    const body = (await response.json()) as { runs: ReviewRunSummary[] }
    const [latest, ...rest] = body.runs
    await route.fulfill({
      response,
      json: {
        runs: latest ? [{ ...latest, reviewStatus: 'finalizing', status: 'ready' }, ...rest] : rest,
      },
    })
  })

  await page.getByRole('button', { name: 'Runden' }).click()
  const finalizing = page.getByRole('row').filter({ hasText: 'Wird abgeschlossen' }).first()
  await expect(finalizing).toBeVisible()
  await expect(finalizing.getByRole('button', { name: /löschen/ })).toBeDisabled()
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
  const saved = page.waitForResponse((response) => {
    const body = response.request().postData() ?? ''
    return (
      /\/api\/reviews\/[^/]+\/state$/.test(new URL(response.url()).pathname) &&
      body.includes('alex@') &&
      body.includes('Team <team@')
    )
  })
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

test('flushes pending reply notes before leaving and reopening the round', async ({ page }) => {
  const notes = 'Diese noch ungespeicherten Stichpunkte müssen einen sofortigen Wechsel überleben.'
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await page.getByLabel('Was soll die Antwort sagen?').pressSequentially(notes)
  await page.getByRole('button', { name: 'Antwort schließen' }).click()
  await page.getByRole('button', { name: 'Runden' }).click()
  await expect(page.getByRole('button', { name: 'Runde öffnen' }).first()).toBeEnabled()
  await page.getByRole('button', { name: 'Runde öffnen' }).first().click()
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

  await page.getByRole('button', { name: 'Runden' }).click()
  const completed = page.getByRole('row').filter({ hasText: 'Abgeschlossen' }).first()
  const completedId = await completed.getAttribute('id')
  expect(completedId).not.toBeNull()
  if (!completedId) return
  const completedRow = page.locator(`#${completedId}`)
  const reanalyze = completedRow.getByRole('button', { name: 'Mit Codex neu analysieren' })
  await expect(reanalyze).toBeEnabled()
  const restartedRequest = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/reviews\/[^/]+\/reanalyze$/.test(new URL(response.url()).pathname),
  )
  await reanalyze.click()
  const restarted = await restartedRequest
  expect(restarted.status()).toBe(202)
  await expect(restarted.json()).resolves.toMatchObject({
    reviewStatus: 'active',
    status: 'analyzing',
  })
  await expect(completedRow.getByRole('button', { name: 'Runde öffnen' })).toBeEnabled({
    timeout: 15_000,
  })
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

test('bundles connected GitHub and Railway notifications without manual grouping controls', async ({
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
  await expect(page.getByText('4 Originale')).toBeVisible()
  await expect(page.locator('.bundle-tools button')).toHaveCount(0)
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

test('does not apply review shortcuts behind open surfaces', async ({ page }) => {
  const currentSubject = page.getByRole('heading', { level: 1 }).filter({
    hasText: 'Deine Verbindung am Montag',
  })
  const unread = page.locator('.keep-button')

  await page.keyboard.press('?')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('heading', { name: 'Tastatur' })).toBeVisible()
  await expect(unread).toHaveAttribute('aria-pressed', 'false')
  await expect(currentSubject).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible()
  await expect(unread).toHaveAttribute('aria-pressed', 'false')
  await expect(currentSubject).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Nachrichtenübersicht öffnen' }).click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('heading', { name: 'Nachrichten' })).toBeVisible()
  await expect(unread).toHaveAttribute('aria-pressed', 'false')
  await expect(currentSubject).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('heading', { name: 'Antwortentwurf' })).toBeVisible()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(unread).toHaveAttribute('aria-pressed', 'false')
  await expect(currentSubject).toBeVisible()
})

test('selects the Codex model and thinking level in settings', async ({ page }) => {
  await page.route('**/api/review/options', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      json: {
        ...body,
        codex: {
          configured: true,
          model: 'gpt-5.6-sol',
          source: 'stored',
          thinkingLevel: 'high',
        },
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
  await page.route('**/api/settings/codex', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          configured: true,
          model: 'gpt-5.6-sol',
          source: 'stored',
          thinkingLevel: 'high',
        },
      })
      return
    }
    const request = route.request().postDataJSON() as { model: string; thinkingLevel: string }
    await route.fulfill({
      json: {
        configured: true,
        model: request.model,
        source: 'stored',
        thinkingLevel: request.thinkingLevel,
      },
    })
  })

  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.getByRole('button', { name: 'Einstellungen' }).click()

  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible()
  expect(
    await page
      .getByLabel('Modell')
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  expect(
    await page
      .getByLabel('Denkaufwand')
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  await expect(page.getByLabel('Modell')).toHaveValue('gpt-5.6-sol')
  await page.getByLabel('Modell').selectOption('gpt-5.6-terra')
  await page.getByLabel('Denkaufwand').selectOption('xhigh')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByLabel('Modell')).toHaveValue('gpt-5.6-terra')
  await expect(page.getByLabel('Denkaufwand')).toHaveValue('xhigh')
  await expect(page.getByRole('button', { name: 'Speichern' })).toBeDisabled()
})

test('keeps Codex settings available during a Fastmail options outage', async ({ page }) => {
  await page.route('**/api/review/options', async (route) => {
    await route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'FASTMAIL_UNAVAILABLE',
          message: 'Fastmail ist gerade nicht erreichbar.',
          retryable: true,
        },
      },
    })
  })
  await page.route('**/api/settings/codex', async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        model: 'gpt-5.6-sol',
        source: 'stored',
        thinkingLevel: 'high',
      },
    })
  })

  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Runden' })).toBeVisible()
  await page.getByRole('button', { name: 'Einstellungen' }).click()

  const dialog = page.getByRole('dialog', { name: 'Einstellungen' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Modell')).toBeEnabled()
  await expect(dialog.getByLabel('Modell')).toHaveValue('gpt-5.6-sol')
  await expect(dialog.getByLabel('Denkaufwand')).toHaveValue('high')
})

test('shows Codex settings failures inside the open settings dialog', async ({ page }) => {
  await page.route('**/api/review/options', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        codex: {
          configured: true,
          model: 'gpt-5.6-sol',
          source: 'stored',
          thinkingLevel: 'high',
        },
        mode: 'live',
      },
    })
  })
  await page.route('**/api/settings/codex', async (route) => {
    await route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'SETTINGS_WRITE_FAILED',
          message: 'Die Codex-Einstellungen konnten nicht gespeichert werden.',
          retryable: true,
        },
      },
    })
  })

  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.getByLabel('Modell').selectOption('gpt-5.6-terra')
  await page.getByRole('button', { name: 'Speichern' }).click()

  const dialog = page.getByRole('dialog', { name: 'Einstellungen' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Die Codex-Einstellungen konnten nicht gespeichert werden.',
  )
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
  await page.getByRole('button', { name: 'Runden' }).click()
  await page.getByRole('button', { name: /Nur Spam/ }).click()
  await startAndOpenRound(page)

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
