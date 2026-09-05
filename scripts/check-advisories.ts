import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Exceptions require a written call-path assessment, exact affected version and expiry.
const exceptions = JSON.parse(
  readFileSync(new URL('../docs/advisory-exceptions.json', import.meta.url), 'utf8'),
) as Array<{ advisory: string; package: string; version: string; reason: string; expires: string }>
const result = spawnSync('pnpm', ['audit', '--json'], { encoding: 'utf8' })
if (result.error || ![0, 1].includes(result.status ?? -1))
  throw new Error('Dependency audit could not run.')
const audit = JSON.parse(result.stdout) as {
  error?: unknown
  advisories?: Record<
    string,
    { github_advisory_id: string; module_name: string; findings: Array<{ version: string }> }
  >
}
if (audit.error || !audit.advisories)
  throw new Error('Dependency audit returned no usable advisory inventory.')
let unreviewed = 0
for (const advisory of Object.values(audit.advisories)) {
  for (const finding of advisory.findings) {
    const reviewed = exceptions.some(
      (item) =>
        item.advisory === advisory.github_advisory_id &&
        item.package === advisory.module_name &&
        item.version === finding.version &&
        item.reason.trim() &&
        Date.parse(item.expires) > Date.now(),
    )
    console.log(
      `${reviewed ? 'Reviewed exception' : 'Review required'}: ${advisory.github_advisory_id} ${advisory.module_name}@${finding.version}`,
    )
    if (!reviewed) unreviewed += 1
  }
}
if (unreviewed)
  throw new Error(`${unreviewed} dependency matches require an applicability review or update.`)
console.log('Dependency advisory review passed.')
