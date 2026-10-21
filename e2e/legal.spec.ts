import { request as httpRequest } from 'node:http'
import { expect, test } from '@playwright/test'
import type { TriageSnapshot } from '../src/shared.ts'

const pages = [
  {
    path: '/impressum',
    title: 'Impressum',
    english: '/legal-notice',
    englishTitle: 'Legal Notice (Impressum)',
    email: 'impressum-inbox-walk@heerlab.com',
  },
  {
    path: '/datenschutz',
    title: 'Datenschutzerklärung',
    english: '/privacy',
    englishTitle: 'Privacy Policy',
    email: 'datenschutz-inbox-walk@heerlab.com',
  },
] as const

test('rejects ambiguous raw paths before production routing and keeps probes working', async ({
  baseURL,
  request,
}) => {
  for (const path of [
    '/api/todo/threads/T1/%252e%252e/%252e%252e/%252e%252e/%252e%252e/privacy',
    '/api/todo/blobs/B1/x%252F..%252F..%252F..%252F..%252F..%252Fprivacy',
    '/privacy/',
    '/%70rivacy',
    '/api/todo/..%2F..%2Fprivacy',
    '/api/todo/x%2f..%2f..%2fprivacy',
    '/api/x/%2e%2e/privacy',
    '/api/x/../privacy',
    '/api/client-config/..%2F..%2Fprivacy',
    '/healthz/../privacy',
    '/assets/../privacy',
    '//privacy',
    '/privacy%2F',
    '/a%5Cb',
    '/a\\b',
    '/%zz',
    'http://localhost/privacy',
  ]) {
    const result = await new Promise<{
      status?: number
      headers: Record<string, unknown>
      body: string
    }>((resolve, reject) => {
      // Preserve the raw target: browser/fetch URL parsing removes dot segments.
      const req = httpRequest(baseURL ?? '', { path }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
    expect(result.status, path).toBe(400)
    expect(result.body).toBe('Bad request')
    expect(result.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.headers['content-security-policy']).toContain("default-src 'none'")
    expect(result.headers['set-cookie']).toBeUndefined()
  }
  const caseSensitive = await request.get('/Privacy')
  expect(caseSensitive.status()).toBe(200)
  expect(await caseSensitive.text()).toContain('<div id="root"')
  for (const path of ['/healthz', '/readyz']) {
    const response = await request.get(path)
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  }
  expect((await (await request.get('/api/todo')).json()).mode).toBe('demo')
})

test('follows legal footer links to self-contained German and English pages', async ({
  page,
  baseURL,
}) => {
  const external: string[] = []
  const requests: string[] = []
  const origin = new URL(baseURL ?? '').origin
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) {
      external.push(url.href)
      return route.abort()
    }
    requests.push(url.pathname)
    return route.continue()
  })
  for (const legal of pages) {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Inbox Walk', exact: true })).toBeVisible()
    await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0)
    requests.length = 0
    await page.locator(`footer a[href="${legal.path}"]`).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(legal.title)
    await page.waitForLoadState('load')
    expect(requests).toEqual([legal.path])
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
    await expect(page.locator('script')).toHaveCount(0)
    for (const text of [
      'Tobias Heer',
      'c/o Impressumservice Dein-Impressum',
      'Stettiner Str. 41',
      '35410 Hungen',
      legal.email,
    ]) {
      await expect(page.locator('main')).toContainText(text)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      page.viewportSize()?.width,
    )
    expect(await page.context().cookies()).toEqual([])
    const siblingPath = legal.path === '/impressum' ? '/datenschutz' : '/impressum'
    await expect(page.locator(`nav a[href="${siblingPath}"]`).first()).toBeVisible()
    requests.length = 0
    await page.getByRole('link', { name: 'English', exact: true }).first().click()
    await expect(page).toHaveURL(new RegExp(`${legal.english}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(legal.englishTitle)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('main')).toContainText('Tobias Heer')
    await page.waitForLoadState('load')
    expect(requests).toEqual([legal.english])
    await expect(page.getByRole('link', { name: 'Deutsch', exact: true }).first()).toHaveAttribute(
      'href',
      legal.path,
    )
    await page.getByRole('link', { name: 'Back to app', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Inbox Walk', exact: true })).toBeVisible()
  }
  expect(external).toEqual([])
})

test('legal routes work with JavaScript disabled and no session', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false })
  try {
    const page = await context.newPage()
    for (const legal of pages) {
      for (const [path, title] of [
        [legal.path, legal.title],
        [legal.english, legal.englishTitle],
      ]) {
        const response = await page.goto(path ?? '/')
        expect(response?.status()).toBe(200)
        expect(response?.headers()['x-robots-tag']).toBe('noindex')
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title ?? '')
        await expect(page.locator('main')).toContainText(legal.email)
        await expect(page.locator('main')).not.toContainText(
          /TODO_LEGAL|\[\[|\]\]|Hetzner|impressum@heerlab\.com|datenschutz@heerlab\.com/,
        )
        if (legal.path === '/impressum') {
          await expect(
            page.getByRole('link', { name: 'beastyrabbit.com/kontakt', exact: true }),
          ).toHaveAttribute('href', 'https://beastyrabbit.com/kontakt?from=inbox-walk')
        } else {
          await expect(page.locator('main')).toContainText('OpenAI Ireland Ltd')
          const table = page.getByRole('table')
          await expect(table).toBeVisible()
          await expect(table.getByRole('columnheader')).toHaveCount(5)
          await expect(table.getByRole('row')).toHaveCount(3)
          await expect(table).toContainText('inbox-walk.mail-colors')
          await expect(table).toContainText(
            path === '/datenschutz'
              ? 'p_session_token (ggf. mit Zusatz)'
              : 'p_session_token (possibly with a suffix)',
          )
          await expect(table).toContainText(
            path === '/datenschutz'
              ? '30 Tage; verlängert sich bei Nutzung'
              : '30 days; extended while in use',
          )
          await expect(page.locator('main')).toContainText(
            path === '/datenschutz'
              ? 'Umami setzt keine Cookies und speichert keine Daten im Browser.'
              : 'Umami sets no cookies and stores no data in your browser.',
          )
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
          page.viewportSize()?.width,
        )
        await expect(page.locator('script')).toHaveCount(0)
      }
    }
    expect(await context.cookies()).toEqual([])
  } finally {
    await context.close()
  }
})

test('legal pages load no telemetry even when integrations are configured', async ({
  page,
  baseURL,
}) => {
  const target = new URL(baseURL ?? '')
  target.port = process.env.MAIL_REVIEW_TELEMETRY_TEST_PORT ?? String(Number(target.port) + 1)
  const config = await page.request.get(`${target.origin}/api/client-config`)
  expect((await config.json()).umami).toMatchObject({ url: 'https://umami.test' })
  const requests: string[] = []
  const external: string[] = []
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    requests.push(url.href)
    if (url.origin !== target.origin) {
      external.push(url.href)
      return route.abort()
    }
    return route.continue()
  })
  for (const path of ['/impressum', '/datenschutz', '/legal-notice', '/privacy']) {
    const response = await page.goto(`${target.origin}${path}`)
    expect(response?.status()).toBe(200)
    const csp = response?.headers()['content-security-policy'] ?? ''
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toMatch(/umami|glitchtip|https?:/)
    await expect(page.locator('script')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }
  expect(requests).toEqual(
    ['/impressum', '/datenschutz', '/legal-notice', '/privacy'].map(
      (path) => `${target.origin}${path}`,
    ),
  )
  expect(external).toEqual([])
  expect(await page.context().cookies()).toEqual([])
})

test('keeps legal links accessible in settings and buckets without triggering mail shortcuts', async ({
  page,
}) => {
  const current = await page.request.get('/api/todo')
  expect(current.ok()).toBe(true)
  const snapshot = (await current.json()) as TriageSnapshot
  expect(snapshot.mode).toBe('demo')
  const reset = await page.request.post('/api/todo/demo-reset', {
    headers: { 'X-Inbox-Walk-CSRF': snapshot.csrfToken },
  })
  expect(reset.ok()).toBe(true)
  await page.goto('/')
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' })
  for (const path of ['/impressum', '/datenschutz']) {
    await expect(dialog.locator(`footer a[href="${path}"]`)).toBeVisible()
  }
  const lastLink = dialog.getByRole('link', { name: 'Datenschutz', exact: true })
  await lastLink.focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Schließen', exact: true }).first()).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Tastatur', exact: true })
  await help.getByRole('link', { name: 'Datenschutz', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await page.getByRole('button', { name: 'Deine Verbindung am Montag öffnen', exact: true }).click()
  await expect(page.locator('iframe.message-body')).toBeVisible()
  const bucketUrl = page.url()
  const before = (await (await page.request.get('/api/todo')).json()) as TriageSnapshot
  const mutations: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') mutations.push(request.url())
  })
  const impressum = page.locator('footer a[href="/impressum"]')
  await expect(impressum).toBeVisible()
  await impressum.focus()
  for (const key of ['e', 'r', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '?', 'Escape']) {
    await page.keyboard.press(key)
  }
  await expect(impressum).toBeFocused()
  await expect(page).toHaveURL(bucketUrl)
  expect(mutations).toEqual([])
  const after = (await (await page.request.get('/api/todo')).json()) as TriageSnapshot
  expect(after.buckets).toEqual(before.buckets)
  await page.keyboard.press('Tab')
  await expect(page.locator('footer a[href="/datenschutz"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Datenschutzerklärung')
})
