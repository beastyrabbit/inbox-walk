import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { TriageSnapshot } from '../src/shared.ts'
import type { ClientConfig } from '../src/telemetry-contract.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const regularBase = `http://127.0.0.1:${process.env.MAIL_REVIEW_TEST_PORT ?? '4173'}`
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
}

for (const maskLevel of ['strict', 'moderate']) {
  test(`telemetry protects mail with ${maskLevel} recorder config`, async ({ page, baseURL }) => {
    const configResponse = await page.request.get(`${baseURL}/api/client-config`)
    expect(configResponse.headers()['cache-control']).toBe('no-store')
    const config = (await configResponse.json()) as ClientConfig
    expect(config.release).toBe('inbox-walk@0.11.1')
    expect(config.umami?.url).toBe('https://umami.test')
    const errorsOrigin = new URL(config.glitchtip?.dsn ?? '').origin
    const current = (await (await page.request.get('/api/todo')).json()) as TriageSnapshot
    expect(current.mode).toBe('demo')
    await page.request.post('/api/todo/demo-reset', {
      headers: { 'X-Inbox-Walk-CSRF': current.csrfToken },
    })
    const snapshot = (await (await page.request.get('/api/todo')).json()) as TriageSnapshot
    const secrets = snapshot.buckets
      .flatMap((bucket) => [
        bucket.bucketId,
        bucket.title,
        bucket.summary,
        bucket.currentState,
        ...bucket.messages.flatMap(({ summary }) => [
          summary.id,
          summary.threadId,
          summary.subject,
          summary.preview,
          ...summary.from.map((from) => from.email),
          ...summary.to.map((to) => to.email),
        ]),
      ])
      .filter((value): value is string => typeof value === 'string' && value.length > 5)
    const requests: Array<{ url: string; body: string }> = []
    let recorderRequested = false
    let recorderConfigRequested = false
    await page.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const telemetry = url.origin === 'https://umami.test' || url.origin === errorsOrigin
      if (!telemetry) {
        if (url.origin === baseURL || url.protocol === 'data:' || url.protocol === 'blob:')
          return route.continue()
        throw new Error('Unexpected external request in isolated demo test')
      }
      requests.push({ url: request.url(), body: request.postData() ?? '' })
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      if (url.pathname === '/script.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: fixture('umami-script.js'),
          headers: cors,
        })
      if (url.pathname === '/recorder.js') {
        recorderRequested = true
        return route.fulfill({
          contentType: 'text/javascript',
          body: fixture('umami-recorder.js'),
          headers: cors,
        })
      }
      if (url.pathname.endsWith('/recorder')) {
        recorderConfigRequested = true
        return route.fulfill({
          headers: cors,
          json: {
            enabled: true,
            replayEnabled: true,
            heatmapEnabled: true,
            sampleRate: 1,
            heatmapSampleRate: 1,
            maskLevel,
            maxDuration: 300000,
            blockSelector: '[data-telemetry-block]',
          },
        })
      }
      return route.fulfill({ headers: cors, json: { cache: 'demo-only-cache' } })
    })
    await page.goto('/')
    const rootResponse = await page.request.get('/')
    expect(rootResponse.headers()['content-security-policy']).toContain('https://umami.test')
    expect(rootResponse.headers()['content-security-policy']).toContain(errorsOrigin)
    await expect(page.locator('#root')).toHaveClass('rr-mask')
    await expect(page.locator('.todo-row').first()).toHaveAttribute('data-telemetry-block', 'true')
    await expect
      .poll(() => requests.some((request) => request.body.includes('app_loaded')))
      .toBe(true)
    expect(requests.some((request) => request.body.includes('"url":"/"'))).toBe(true)
    await page.getByRole('button', { name: /Re: Essen nächste Woche.* öffnen/ }).click()
    await expect(page.locator('iframe.message-body')).toHaveAttribute(
      'data-telemetry-block',
      'true',
    )
    await expect(page.locator('iframe.message-body')).toHaveClass(/rr-block/)
    await expect(page.locator('.message-card')).toHaveAttribute('data-telemetry-block', 'true')
    await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
    await expect(page.locator('.reply-panel')).toHaveClass(/rr-block/)
    await expect(page.locator('.reply-panel')).toHaveAttribute('data-telemetry-block', 'true')
    const privateNote = `Private note for the dinner reply ${maskLevel} ${Date.now()}`
    secrets.push(privateNote)
    await page.getByLabel('Was soll die Antwort sagen?').fill(privateNote)
    await page.getByRole('button', { name: 'Entwurf erstellen' }).click()
    await expect
      .poll(() => requests.some((request) => request.body.includes('reply_draft_created')))
      .toBe(true)
    await page.getByRole('button', { name: 'Antwort schließen' }).click()
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
    await expect(page.locator('[aria-labelledby="settings-memory-title"]')).toHaveClass(/rr-block/)
    await expect(page.locator('[aria-labelledby="settings-memory-title"]')).toHaveAttribute(
      'data-telemetry-block',
      'true',
    )
    await page.getByLabel('Notizen für Codex').fill(privateNote)
    await page.getByRole('button', { name: 'Notizen speichern' }).click()
    await expect
      .poll(() => requests.some((request) => request.body.includes('memory_note_saved')))
      .toBe(true)
    await page.getByRole('dialog', { name: 'Einstellungen' }).getByLabel('Schließen').click()
    // Attempt leaks through exception messages, console arguments and unblocked DOM attributes.
    await page.evaluate((text) => {
      const div = document.createElement('div')
      div.title = text
      div.setAttribute('data-mail-id', text)
      div.textContent = text
      document.getElementById('root')?.append(div)
      console.error(text)
      window.setTimeout(() => {
        throw new Error(text)
      }, 0)
    }, secrets.join(' | '))
    await expect
      .poll(() => requests.filter((request) => request.url.includes('/envelope/')).length)
      .toBeGreaterThanOrEqual(2)
    const envelopes = requests
      .filter((request) => request.url.includes('/envelope/'))
      .map((request) => request.body)
      .join('\n')
    expect(envelopes).toContain('"release":"inbox-walk@0.11.1"')
    expect(envelopes).toContain('"environment":"e2e"')
    expect(envelopes).toContain('Application error (details withheld)')
    await page.keyboard.press('e')
    await expect
      .poll(() => requests.some((request) => request.body.includes('bucket_done')))
      .toBe(true)
    for (const path of ['/bucket', '/reply', '/settings']) {
      expect(requests.some((request) => request.body.includes(`"url":"${path}"`))).toBe(true)
    }
    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.url.endsWith('/api/record') && request.body.includes('"type":"record"'),
        ),
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          requests.some(
            (request) =>
              request.url.endsWith('/api/record') && request.body.includes('"type":"heatmap"'),
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
    expect(recorderRequested).toBe(true)
    expect(recorderConfigRequested).toBe(true)
    const captured = JSON.stringify(requests)
    for (const secret of secrets) {
      expect(captured).not.toContain(secret)
      expect(captured).not.toContain(encodeURIComponent(secret))
    }
    expect(await page.context().cookies()).toEqual([])
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([])
    await expect(page.getByText(/consent|cookie-banner|einwilligung/i)).toHaveCount(0)
    // Hidden maps exist for upload but are never served, even outside the container.
    expect((await page.request.get('/assets/private.js.map')).status()).toBe(404)
  })
}

test('unset runtime telemetry makes no requests and loads no SDK chunks', async ({ page }) => {
  const external: string[] = []
  const scripts: string[] = []
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== regularBase && !['data:', 'blob:'].includes(url.protocol)) {
      external.push(url.href)
      return route.abort()
    }
    if (url.pathname.endsWith('.js')) scripts.push(url.pathname)
    return route.continue()
  })
  await page.goto(regularBase)
  await expect(page.locator('.todo-row').first()).toBeVisible()
  const config = await (await page.request.get(`${regularBase}/api/client-config`)).json()
  expect(config).toEqual({ release: 'inbox-walk@0.11.1' })
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Tastatur' })).toBeVisible()
  expect(external).toEqual([])
  expect(scripts.some((url) => /errors-|telemetry-replay-|script\.js|recorder\.js/.test(url))).toBe(
    false,
  )
})
