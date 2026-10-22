import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

type Options = {
  repository: string
  sha: string
  token: string
  timeoutMs?: number
  intervalMs?: number
  fetcher?: typeof fetch
}

type Run = {
  id: number
  event: string
  head_branch: string
  head_sha: string
  status: string
  conclusion: string | null
}

function validRun(run: Run) {
  return Boolean(
    run &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      typeof run.event === 'string' &&
      typeof run.head_branch === 'string' &&
      typeof run.head_sha === 'string' &&
      typeof run.status === 'string' &&
      (run.conclusion === null || typeof run.conclusion === 'string'),
  )
}

export async function waitMainCi({
  repository,
  sha,
  token,
  timeoutMs = 35 * 60_000,
  intervalMs = 15_000,
  fetcher = fetch,
}: Options) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !token)
    throw new Error('Repository, peeled commit SHA and GitHub token are required.')
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yaml/runs`)
  url.search = new URLSearchParams({
    event: 'push',
    branch: 'main',
    head_sha: sha,
    per_page: '100',
  }).toString()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
    })
    if (response.status !== 200) throw new Error(`Main CI API returned HTTP ${response.status}.`)
    const data = (await response.json()) as { workflow_runs?: Run[] }
    if (!Array.isArray(data?.workflow_runs) || data.workflow_runs.some((run) => !validRun(run)))
      throw new Error('Malformed main CI API response.')
    // Recheck API filters locally. Never fall back to an ancestor, PR or manual run.
    const newest = data.workflow_runs
      .filter((run) => run.event === 'push' && run.head_branch === 'main' && run.head_sha === sha)
      .sort((a, b) => b.id - a.id)[0]
    if (Date.now() >= deadline) break
    if (newest?.status === 'completed') {
      if (newest.conclusion !== 'success')
        throw new Error(`Newest main CI run ${newest.id} concluded ${newest.conclusion}.`)
      console.log(`Main CI run ${newest.id} succeeded for ${sha}.`)
      return
    }
    console.log(
      newest ? `Waiting for main CI run ${newest.id}.` : 'Waiting for exact-commit main CI.',
    )
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())))
  }
  throw new Error(`Timed out waiting for successful main CI for ${sha}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await waitMainCi({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: execFileSync('git', ['rev-parse', 'HEAD^{commit}'], { encoding: 'utf8' }).trim(),
    token: process.env.GH_TOKEN ?? '',
  })
}
