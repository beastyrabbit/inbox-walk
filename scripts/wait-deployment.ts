import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const service = 'http://inbox-walk.tools.svc.cluster.local:3000'
const numericIdentifier = /^(0|[1-9]\d*)$/

function validIdentifiers(value: string | undefined, prerelease = false) {
  if (value === undefined) return true
  return value
    .split('.')
    .every(
      (part) =>
        /^[\da-zA-Z-]+$/.test(part) &&
        (!prerelease || !/^\d+$/.test(part) || numericIdentifier.test(part)),
    )
}

function versionParts(release: string) {
  const match = /^inbox-walk@(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z.-]+))?(?:\+([\da-zA-Z.-]+))?$/.exec(
    release,
  )
  if (
    !match?.slice(1, 4).every((part) => numericIdentifier.test(part)) ||
    !validIdentifiers(match[4], true) ||
    !validIdentifiers(match[5])
  )
    throw new Error('Malformed deployment release.')
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') }
}

function isNewer(actual: string, expected: string) {
  const a = versionParts(actual)
  const b = versionParts(expected)
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i]
  }
  if (!a.prerelease || !b.prerelease) return !a.prerelease && Boolean(b.prerelease)
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === right) continue
    if (left === undefined || right === undefined) return right === undefined
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right)
    if (leftNumeric !== rightNumeric) return rightNumeric
    return left > right
  }
  return false
}

class Retryable extends Error {}

async function checkRelease(
  expected: string,
  get: (path: string, contentType: string) => Promise<Response>,
) {
  const config = await (await get('/api/client-config', 'application/json')).json()
  if (!config || typeof config.release !== 'string')
    throw new Error('Malformed client config response.')
  if (isNewer(config.release, expected)) {
    console.log(`Release ${expected} superseded by ${config.release}; skipping rollout smoke.`)
    return 'superseded' as const
  }
  if (config.release !== expected) {
    console.log(`Waiting for ${expected}; Service currently reports ${config.release}.`)
    return undefined
  }
  const html = await (await get('/', 'text/html')).text()
  if (!/^<!doctype html>/i.test(html.trimStart()) || !/<div\s+id="root"/.test(html))
    throw new Error('Malformed application HTML.')
  const health = await (await get('/healthz', 'application/json')).json()
  if (health?.status !== 'ok') throw new Error('Malformed health response.')
  return 'deployed' as const
}

export async function waitDeployment({
  expected,
  baseUrl = service,
  timeoutMs = 25 * 60_000,
  reachabilityMs = 60_000,
  intervalMs = 10_000,
  fetcher = fetch,
}: {
  expected: string
  baseUrl?: string
  timeoutMs?: number
  reachabilityMs?: number
  intervalMs?: number
  fetcher?: typeof fetch
}) {
  versionParts(expected)
  const deadline = Date.now() + timeoutMs
  const reachabilityDeadline = Math.min(deadline, Date.now() + reachabilityMs)
  let reachable = false
  console.log('Checking internal Service reachability before waiting for Flux.')

  async function get(path: string, contentType: string) {
    let response: Response
    try {
      response = await fetcher(new URL(path, baseUrl), {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
      })
    } catch {
      throw new Retryable('Internal Service request failed.')
    }
    reachable = true
    if (response.status >= 500) throw new Retryable(`Service returned HTTP ${response.status}.`)
    if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}.`)
    if (response.headers.get('content-type')?.split(';')[0].trim() !== contentType)
      throw new Error(`${path} returned an unexpected content type.`)
    return response
  }

  while (Date.now() < deadline) {
    try {
      const result = await checkRelease(expected, get)
      if (Date.now() >= deadline) break
      if (result) {
        console.log(`Deployment check for ${expected}: ${result}.`)
        return result
      }
    } catch (error) {
      if (!(error instanceof Retryable)) throw error
      console.log(error.message)
    }
    if (!reachable && Date.now() >= reachabilityDeadline)
      throw new Error('Internal Service is unreachable from this runner.')
    const remaining = (reachable ? deadline : reachabilityDeadline) - Date.now()
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(intervalMs, remaining))),
    )
  }
  throw new Error(`Timed out waiting for deployment of ${expected}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  await waitDeployment({ expected: `inbox-walk@${version}` })
}
