import { readFileSync } from 'node:fs'

const ref = process.argv[2] ?? process.env.GITHUB_REF ?? ''
if (ref.startsWith('refs/tags/')) {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  if (ref !== `refs/tags/v${version}`)
    throw new Error(`Release tag must match package version v${version}.`)
}
