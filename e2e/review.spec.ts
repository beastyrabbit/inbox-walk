import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Deine Verbindung am Montag' })).toBeVisible()
})

test('reviews mail with keyboard decisions and exact overview navigation', async ({ page }) => {
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('button', { name: /Bleibt ungelesen/ })).toHaveAttribute(
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
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowRight')
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
  await expect(page.getByText('3 bleiben ungelesen')).toBeVisible()
  await page.getByRole('button', { name: 'Änderungen speichern' }).click()
  await expect(page.getByRole('heading', { name: 'Review abgeschlossen' })).toBeVisible()
  await expect(page.getByText(/3 noch nicht bearbeitete Nachrichten/)).toBeVisible()
})

test('opens keyboard help and closes it with Escape', async ({ page }) => {
  await page.keyboard.press('?')
  await expect(page.getByRole('heading', { name: 'Tastatur' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Tastatur' })).toBeHidden()
})
