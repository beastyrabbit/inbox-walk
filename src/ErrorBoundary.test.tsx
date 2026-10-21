// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { reportBrowserError } from './telemetry.ts'

vi.mock('./telemetry.ts', () => ({ reportBrowserError: vi.fn() }))

it('shows a German reload fallback and reports React render failures', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const element = document.createElement('div')
  const root = createRoot(element)
  const error = new Error('Private subject')
  function Broken(): never {
    throw error
  }
  try {
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Broken />
        </ErrorBoundary>,
      )
    })
    expect(element.textContent).toContain('Inbox Walk konnte nicht angezeigt werden.')
    expect(element.querySelector('button')?.textContent).toBe('Seite neu laden')
    expect(reportBrowserError).toHaveBeenCalledWith(error)
    expect(element.textContent).not.toContain('Private subject')
  } finally {
    await act(async () => root.unmount())
    consoleError.mockRestore()
    vi.unstubAllGlobals()
  }
})
