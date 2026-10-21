import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { privacyPolicies } from './legal/content.ts'
import { legalRoutes, renderLegalPage, serveLegalPage } from './legal/pages.ts'

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (!serveLegalPage(req, res)) {
      res.statusCode = 404
      res.end('Not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Legal test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

function assertNoLegalTodos(html: string) {
  expect(html).not.toMatch(/TODO_LEGAL|\[\[|\]\]/)
}

describe('standalone legal routes', () => {
  it.each(Object.entries(legalRoutes))(
    '%s is session-free, self-contained and noindex',
    async (path, route) => {
      const response = await fetch(`${baseUrl}${path}`)
      const html = await response.text()
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('x-robots-tag')).toBe('noindex')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(html).toContain(`<html lang="${route.language}">`)
      expect(html).toContain('<meta name="robots" content="noindex">')
      expect(html).not.toMatch(
        /<script\b|<iframe\b|<form\b|<link[^>]*stylesheet|\ssrc=|@import|url\(/i,
      )
      expect(html).not.toContain('<!--')
      expect(html).not.toContain('[[')
      for (const line of [
        'Tobias Heer',
        'c/o Impressumservice Dein-Impressum',
        'Stettiner Str. 41',
        '35410 Hungen',
        route.kind === 'notice'
          ? 'impressum-inbox-walk@heerlab.com'
          : 'datenschutz-inbox-walk@heerlab.com',
      ])
        expect(html).toContain(line)
      expect(html).toContain('href="/"')
      expect(html).not.toMatch(/Hetzner|impressum@heerlab\.com|datenschutz@heerlab\.com/i)
      const otherLanguage = route.language === 'de' ? 'en' : 'de'
      for (const [target, targetRoute] of Object.entries(legalRoutes)) {
        if (
          (targetRoute.language === route.language && targetRoute.kind !== route.kind) ||
          (targetRoute.language === otherLanguage && targetRoute.kind === route.kind)
        )
          expect(html).toContain(`href="${target}"`)
      }
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]
      expect(style).toBeDefined()
      const csp = response.headers.get('content-security-policy') ?? ''
      expect(csp).toContain(
        `style-src 'sha256-${createHash('sha256')
          .update(style ?? '')
          .digest('base64')}'`,
      )
      for (const directive of [
        "default-src 'none'",
        "script-src 'none'",
        "connect-src 'none'",
        "font-src 'none'",
        "form-action 'none'",
      ]) {
        expect(csp).toContain(directive)
      }
      expect(csp).not.toMatch(/unsafe-inline|https?:/)
      if (route.kind === 'notice') {
        assertNoLegalTodos(html)
        expect(html).toContain('href="https://beastyrabbit.com/kontakt?from=inbox-walk"')
        expect(html).not.toMatch(/Verantwortlich für den Inhalt|Responsible for content|MStV/)
      } else {
        expect(html).not.toMatch(/Kontaktformular|Contact form/)
        expect(html).toContain('https://inbox-walk.heerlab.com')
        expect(html.match(/<h2 /g)).toHaveLength(17)
        expect(html).toContain('OpenAI Ireland Ltd')
        expect(html).toContain('<table>')
        expect(html.match(/<th scope="col">/g)).toHaveLength(5)
        expect(html.match(/<td>/g)).toHaveLength(10)
        expect(html).toContain('inbox-walk.mail-colors (localStorage)')
        expect(html).toContain(
          route.language === 'de'
            ? 'p_session_token (ggf. mit Zusatz)'
            : 'p_session_token (possibly with a suffix)',
        )
        expect(html).toContain(
          route.language === 'de'
            ? '30 Tage; verlängert sich bei Nutzung'
            : '30 days; extended while in use',
        )
        expect(html).toContain(
          route.language === 'de'
            ? 'Umami setzt keine Cookies und speichert keine Daten im Browser.'
            : 'Umami sets no cookies and stores no data in your browser.',
        )
        expect(html).toContain(route.language === 'de' ? '21. Oktober 2026' : 'October 21, 2026')
      }
    },
  )

  it.each(Object.keys(legalRoutes))('supports HEAD and rejects mutations at %s', async (path) => {
    const head = await fetch(`${baseUrl}${path}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('x-robots-tag')).toBe('noindex')
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(1000)
    expect(await head.text()).toBe('')
    const post = await fetch(`${baseUrl}${path}`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect(post.headers.get('set-cookie')).toBeNull()
  })

  it('matches only the four exact paths and also handles a query string', async () => {
    for (const path of [
      '/impressum/',
      '/datenschutz/extra',
      '/legal-notice.css',
      '/Privacy',
      '/',
    ]) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(404)
    }
    expect((await fetch(`${baseUrl}/privacy?language=en`)).status).toBe(200)
  })

  it('renumbers privacy headings when a section is inserted', () => {
    privacyPolicies.de.sections.splice(1, 0, { heading: 'Zusätzlicher Abschnitt', body: 'Text' })
    try {
      const html = renderLegalPage('/datenschutz')
      expect(html).toContain('>2. Zusätzlicher Abschnitt</h2>')
      expect(html).toContain('>3. Überblick</h2>')
      expect(html).toContain('>18. Änderungen</h2>')
      expect(html).toContain('Die im Abschnitt „E-Mail-Verarbeitung und gespeicherte Daten“')
    } finally {
      privacyPolicies.de.sections.splice(1, 1)
    }
  })

  it('escapes table cells and rejects unsafe links', () => {
    const section = privacyPolicies.en.sections.find(
      (item) => item.heading === 'Cookies and local storage',
    )
    if (!section) throw new Error('Missing browser storage section')
    const original = section.body
    section.body =
      '| <script>alert(1)</script> | Link |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [unsafe](javascript:alert) |\n| Safe | [safe](https://example.com/?x="value"&y=1) |'
    try {
      const html = renderLegalPage('/privacy')
      expect(html).toContain('<th scope="col">&lt;script&gt;alert(1)&lt;/script&gt;</th>')
      expect(html).toContain('<td>&lt;img src=x onerror=alert(1)&gt;</td>')
      expect(html).toContain('<td>unsafe</td>')
      expect(html).toContain('href="https://example.com/?x=&quot;value&quot;&amp;y=1"')
      expect(html).not.toMatch(/<script|<img|javascript:/)
    } finally {
      section.body = original
    }
  })

  it('contains no unresolved placeholders on any page before publication', () => {
    for (const path of Object.keys(legalRoutes) as Array<keyof typeof legalRoutes>) {
      assertNoLegalTodos(renderLegalPage(path))
    }
  })
})
