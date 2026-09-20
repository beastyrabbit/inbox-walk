import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import type { TriageSnapshot } from '../src/shared.ts'

const { version: appVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

async function resetDemo(page: Page) {
  const current = await page.request.get('/api/todo')
  expect(current.ok()).toBe(true)
  const snapshot = (await current.json()) as TriageSnapshot
  expect(snapshot.mode).toBe('demo')
  const reset = await page.request.post('/api/todo/demo-reset', {
    headers: { 'X-Inbox-Walk-CSRF': snapshot.csrfToken },
  })
  expect(reset.ok()).toBe(true)
  return (await reset.json()) as TriageSnapshot
}

async function todo(page: Page) {
  return (await (await page.request.get('/api/todo')).json()) as TriageSnapshot
}

async function openBucket(page: Page, title: RegExp) {
  await page.getByRole('button', { name: title }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
}

test.beforeEach(async ({ page }) => {
  await resetDemo(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Inbox Walk' })).toBeVisible()
})

test('lists every unread message in sorted buckets with the release version', async ({ page }) => {
  await expect(page.getByText(`v${appVersion}`)).toBeVisible()
  await expect(page.getByText(/Lokale Sortierung/)).toBeVisible()
  const rows = page.locator('.todo-row')
  await expect(rows).toHaveCount(5)
  await expect(page.getByText('9 Nachrichten in 5 Buckets')).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Railway deployment successful .* öffnen/ }),
  ).toContainText('4 Nachrichten')
  await expect(page.getByRole('button', { name: /Sendungsnummer .* öffnen/ })).toContainText(
    '2 Nachrichten',
  )
  await expect(page.getByRole('button', { name: /Wird einsortiert/ })).toHaveCount(0)
})

test('marks a bucket done with the keyboard and moves on to the next one', async ({ page }) => {
  await openBucket(page, /Deine Verbindung am Montag/)
  await expect(page.locator('iframe.message-body')).toBeVisible()
  await page.keyboard.press('e')
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Deine Verbindung am Montag/)
  const snapshot = await todo(page)
  expect(snapshot.buckets).toHaveLength(4)
  expect(
    snapshot.buckets.some((bucket) =>
      bucket.messages.some((message) => message.summary.id === 'demo-train'),
    ),
  ).toBe(false)
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.todo-row')).toHaveCount(4)
})

test('shows every message of a story at once and selects one per pane head', async ({ page }) => {
  await openBucket(page, /Railway deployment successful/)
  const panes = page.getByRole('list', { name: 'Verlauf der Story' }).getByRole('listitem')
  await expect(panes).toHaveCount(4)
  await expect(page.locator('iframe.message-body')).toHaveCount(4)
  await page.getByRole('button', { name: /Railway deployment failed/ }).click()
  await expect(page.locator('.story-pane.selected')).toContainText('Railway deployment failed')
  await page.locator('.message-details summary').click()
  await expect(page.locator('.original-subject')).toHaveText(/Railway deployment failed/)
})

test('parks a message unread and brings it back from the parked section', async ({ page }) => {
  await openBucket(page, /Re: Essen nächste Woche\?/)
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Re: Essen/)
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.todo-row')).toHaveCount(4)
  expect((await todo(page)).parked.map((message) => message.summary.id)).toEqual(['demo-human'])
  await page.getByRole('button', { name: '1 anzeigen' }).click()
  await page.getByRole('button', { name: 'Zurückholen' }).click()
  await expect(page.locator('.todo-row')).toHaveCount(5)
  expect((await todo(page)).parked).toEqual([])
})

test('marks newsletters for deferred unsubscribe work without touching read state', async ({
  page,
}) => {
  await openBucket(page, /Samstagsbrief · Augustanfang/)
  const action = page.getByRole('button', { name: 'Für spätere Abmeldung markieren' })
  await expect(action).toBeEnabled()
  await action.click()
  await expect(page.locator('[aria-live="polite"]')).toHaveText(
    'Mit „Newsletter abmelden“ markiert.',
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Samstagsbrief/)
  const snapshot = await todo(page)
  expect(
    snapshot.buckets.some((bucket) =>
      bucket.messages.some((message) => message.summary.id === 'demo-news'),
    ),
  ).toBe(true)
  await page.keyboard.press('ArrowLeft')
  await openBucket(page, /Deine Verbindung am Montag/)
  await expect(page.getByRole('button', { name: 'Kein Newsletter erkannt' })).toBeDisabled()
})

test('drafts a reply into Fastmail and keeps the notes across a reload', async ({ page }) => {
  await openBucket(page, /Re: Essen nächste Woche\?/)
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('heading', { name: 'Antwortentwurf' })).toBeVisible()
  await expect(page.getByText(/Alle 1 Thread-Nachrichten/)).toBeVisible()
  await expect(page.getByRole('button', { name: /senden/i })).toHaveCount(0)
  await page
    .getByLabel('Was soll die Antwort sagen?')
    .pressSequentially('Dienstag passt mir gut.', { delay: 10 })
  await page.getByRole('button', { name: 'Entwurf erstellen' }).click()
  await expect(page.getByRole('textbox', { name: 'Antwort', exact: true })).toHaveValue(/Dienstag/)
  await page.getByRole('button', { name: 'In Fastmail als Draft speichern' }).click()
  await expect(page.getByText(/Draft gespeichert und verifiziert/)).toBeVisible()
  await page.waitForTimeout(900)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Re: Essen nächste Woche\?/)
  await page.keyboard.press('r')
  await expect(page.getByLabel('Was soll die Antwort sagen?')).toHaveValue(
    'Dienstag passt mir gut.',
  )
})

test('refetches the thread every time the reply panel opens', async ({ page }) => {
  let threadRequests = 0
  page.on('request', (request) => {
    if (/\/api\/todo\/threads\//.test(request.url())) threadRequests += 1
  })
  await openBucket(page, /Re: Essen nächste Woche\?/)
  const panel = page.getByRole('heading', { name: 'Antwortentwurf' })
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(panel).toBeVisible()
  await expect.poll(() => threadRequests).toBe(1)
  await page.getByRole('button', { name: 'Antwort schließen' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(panel).toBeVisible()
  await expect.poll(() => threadRequests).toBe(2)
})

test('keeps a bucket URL across reload and returns to the list when it closes', async ({
  page,
}) => {
  await openBucket(page, /Deine Verbindung am Montag/)
  const url = page.url()
  expect(url).toMatch(/\/buckets\//)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Deine Verbindung am Montag/)
  const snapshot = await todo(page)
  const done = await page.request.post('/api/todo/messages/done', {
    data: { emailIds: ['demo-train'] },
    headers: { 'X-Inbox-Walk-CSRF': snapshot.csrfToken },
  })
  expect(done.ok()).toBe(true)
  await expect(page.locator('.todo-row')).toHaveCount(4, { timeout: 20_000 })
  expect(page.url()).not.toMatch(/\/buckets\//)
})

test('saves memory notes for Codex and keeps them after a reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' })
  await expect(dialog.getByRole('heading', { name: 'Gedächtnis' })).toBeVisible()
  await dialog.getByLabel('Notizen für Codex').fill('Bahn-Buchungen gehören zur Reise.')
  await dialog.getByRole('button', { name: 'Notizen speichern' }).click()
  await expect(dialog.getByRole('button', { name: 'Notizen speichern' })).toBeDisabled()
  await page.reload()
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await expect(page.getByLabel('Notizen für Codex')).toHaveValue(
    'Bahn-Buchungen gehören zur Reise.',
  )
  expect((await todo(page)).memory.notes).toBe('Bahn-Buchungen gehören zur Reise.')
})

test('shows the model, thinking level and speed configured in Codex', async ({ page }) => {
  const codex = {
    authSource: 'codex',
    configured: true,
    model: 'gpt-6-astra',
    modelLabel: 'GPT 6.0 Astra',
    settingsPath: '/home/test/.codex/config.toml',
    settingsSource: 'codex',
    source: 'stored',
    speed: 'fast',
    thinkingLevel: 'xhigh',
  }
  await page.route('**/api/todo', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as TriageSnapshot
    await route.fulfill({ json: { ...body, codex, mode: 'live' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' })
  await expect(dialog.getByText('GPT 6.0 Astra')).toBeVisible()
  await expect(dialog.getByText('gpt-6-astra')).toBeVisible()
  await expect(dialog.getByText('Sehr hoch')).toBeVisible()
  await expect(dialog.getByText('Schnell')).toBeVisible()
  await expect(dialog.getByText('Gelesen aus /home/test/.codex/config.toml.')).toBeVisible()
  await expect(dialog.getByText('codex login')).toBeVisible()
  await expect(dialog.getByRole('button', { name: /verbinden/ })).toHaveCount(0)
})

test('offers to connect Codex when sorting waits for a login', async ({ page }) => {
  await page.route('**/api/todo', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as TriageSnapshot
    await route.fulfill({
      json: {
        ...body,
        codex: { ...body.codex, authSource: 'pi', configured: false },
        mode: 'live',
        status: { ...body.status, engine: 'codex', queuedCount: 3, waitingForCodex: true },
      },
    })
  })
  await page.goto('/')
  await expect(page.getByText('Sortierung wartet auf die Codex-Anmeldung.')).toBeVisible()
  await page.getByRole('button', { name: 'Codex verbinden' }).click()
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' })
  await expect(dialog.getByRole('button', { name: 'Mit ChatGPT verbinden' })).toBeVisible()
})

test('flags messages that could not be sorted and offers a retry', async ({ page }) => {
  await page.route('**/api/todo', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as TriageSnapshot
    const [first, ...rest] = body.buckets
    if (!first) throw new Error('Demo todo is empty')
    const message = { ...first.messages[0], attempts: 3, lastError: 'Codex war nicht erreichbar.' }
    await route.fulfill({
      json: {
        ...body,
        buckets: [{ ...first, messages: [message], unsorted: true }, ...rest],
        status: { ...body.status, failedCount: 1, lastSortError: 'Codex war nicht erreichbar.' },
      },
    })
  })
  await page.goto('/')
  await expect(page.getByText(/nach drei Versuchen nicht einsortiert/)).toBeVisible()
  await expect(page.getByText('Sortierung fehlgeschlagen')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Erneut sortieren' })).toBeVisible()
})

test('opens keyboard help and closes it with Escape', async ({ page }) => {
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Tastatur' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Tastatur' })).toHaveCount(0)
})

test('does not apply shortcuts behind open surfaces', async ({ page }) => {
  await openBucket(page, /Deine Verbindung am Montag/)
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.keyboard.press('e')
  await page.keyboard.press('ArrowUp')
  await page.getByRole('dialog', { name: 'Einstellungen' }).getByLabel('Schließen').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Deine Verbindung am Montag/)
  expect((await todo(page)).buckets).toHaveLength(5)
})

test('uses a script-disabled same-origin mail sandbox and proxies remote images', async ({
  page,
}) => {
  const external: string[] = []
  await page.route('https://**/*', (route) => {
    external.push(route.request().url())
    return route.abort()
  })
  await page.route('**/api/todo/emails/demo-shop/images/*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      headers: { 'Cache-Control': 'private, no-store' },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  )
  await openBucket(page, /Sendungsnummer/)
  const frame = page.locator('iframe.message-body').first()
  await expect(frame).toHaveAttribute('sandbox', /allow-same-origin/)
  await expect(frame).not.toHaveAttribute('sandbox', /allow-scripts/)
  const image = page.frameLocator('iframe.message-body').first().locator('img').first()
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    )
    .toBe(true)
  expect(external).toEqual([])
})

test('fills the window with mail and keeps the list readable on narrow screens', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 393, height: 851 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(page.locator('.todo-row').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
  }
  await page.setViewportSize({ width: 1280, height: 720 })
  await openBucket(page, /Deine Verbindung am Montag/)
  const frame = page.locator('iframe.message-body')
  await expect(frame).toBeVisible()
  const box = await frame.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('Message frame is missing')
  expect(box.width).toBe(1280)
  expect(box.height).toBeGreaterThan(720 * 0.55)
  const controls = await page.locator('.controls').boundingBox()
  expect(controls).not.toBeNull()
  if (!controls) throw new Error('Walk controls are missing')
  expect(controls.y + controls.height).toBeLessThanOrEqual(720)
})
