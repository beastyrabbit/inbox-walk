// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { api } from './api.ts'
import { ErrorBoundary, LegalFooter } from './ErrorBoundary.tsx'

vi.mock('./telemetry.ts', () => ({
  durationBucket: vi.fn(),
  failureCategory: vi.fn(),
  interactionType: vi.fn(),
  pageView: vi.fn(),
  reportBrowserError: vi.fn(),
  track: vi.fn(),
}))

function assertLinks(element: HTMLElement) {
  expect(element.querySelector('footer nav[aria-label="Rechtliche Informationen"]')).not.toBeNull()
  const links = [...element.querySelectorAll('footer a')]
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Impressum', '/impressum'],
    ['Datenschutz', '/datenschutz'],
  ])
  expect(element.querySelector('a[tabindex], a[role="button"]')).toBeNull()
}

describe('legal footer', () => {
  it.each(['footer', 'loading', 'error', 'boundary'] as const)(
    'keeps plain navigation links available in the %s layout',
    async (state) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      const todo = vi.spyOn(api, 'todo')
      if (state === 'error') todo.mockRejectedValue(new Error('Offline'))
      else todo.mockReturnValue(new Promise(() => {}))
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const element = document.createElement('div')
      const root = createRoot(element)
      function Broken(): never {
        throw new Error('Render failure')
      }
      try {
        await act(async () => {
          root.render(
            state === 'footer' ? (
              <LegalFooter />
            ) : state === 'boundary' ? (
              <ErrorBoundary>
                <Broken />
              </ErrorBoundary>
            ) : (
              <App />
            ),
          )
        })
        assertLinks(element)
        if (state === 'loading') expect(element.querySelector('[aria-busy="true"]')).not.toBeNull()
        if (state === 'error') expect(element.textContent).toContain('Postfach nicht erreichbar')
        if (state === 'boundary')
          expect(element.textContent).toContain('Inbox Walk konnte nicht angezeigt werden.')
      } finally {
        await act(async () => root.unmount())
        todo.mockRestore()
        consoleError.mockRestore()
        vi.unstubAllGlobals()
      }
    },
  )
})
