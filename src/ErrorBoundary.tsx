import { Component, type ReactNode } from 'react'
import { reportBrowserError } from './telemetry.ts'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    reportBrowserError(error)
  }
  render() {
    if (this.state.failed)
      return (
        <main className="state-page" role="alert">
          <h1>Inbox Walk konnte nicht angezeigt werden.</h1>
          <p>Bitte lade die Seite erneut. Deine Nachrichten bleiben erhalten.</p>
          <button type="button" className="button primary" onClick={() => location.reload()}>
            Seite neu laden
          </button>
        </main>
      )
    return this.props.children
  }
}
