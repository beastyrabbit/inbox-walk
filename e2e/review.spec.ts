import { expect, test } from '@playwright/test'

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

test('creates and verifies a draft without exposing a send action', async ({ page }) => {
  await page.getByRole('button', { name: /Antwort entwerfen/ }).click()
  await expect(page.getByRole('heading', { name: 'Antwortentwurf' })).toBeVisible()
  await expect(page.getByText(/Alle 1 Thread-Nachrichten/)).toBeVisible()
  await expect(page.getByRole('button', { name: /senden/i })).toHaveCount(0)

  await page
    .getByLabel('Was soll die Antwort sagen?')
    .fill('Bitte kurz bestätigen, dass ich das Ticket habe.')
  await page.getByRole('button', { name: 'Entwurf erstellen' }).click()
  await expect(page.getByRole('textbox', { name: 'Antwort', exact: true })).toHaveValue(/Ticket/)
  await page.getByRole('button', { name: 'In Fastmail als Draft speichern' }).click()
  await expect(page.getByText(/Draft gespeichert und verifiziert/)).toBeVisible()
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
