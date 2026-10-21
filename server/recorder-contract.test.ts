import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('pins rr-block and inherited rr-mask with a custom recorder block selector', () => {
  const recorder = readFileSync(
    new URL('../e2e/fixtures/umami-recorder.js', import.meta.url),
    'utf8',
  )
  expect(recorder).toContain('blockClass:n="rr-block",blockSelector:o=null')
  expect(recorder).toContain('maskTextClass:l="rr-mask",maskTextSelector:c=null')
  expect(recorder).toMatch(/n\.closest\(`\.\$\{t\}`\)/)
  expect(recorder).toContain(
    '"strict"===e?{maskAllInputs:!0,maskTextSelector:"*"}:{maskAllInputs:!0}',
  )
  expect(recorder).toContain('...M&&{blockSelector:M}')
  expect(recorder).toContain('recordCanvas:!1,recordCrossOriginIframes:!1')
})
