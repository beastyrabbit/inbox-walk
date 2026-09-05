import { performance } from 'node:perf_hooks'
import { buildReviewBundlesFromPartition } from '../server/bundles.ts'
import { restoreBundleGroups } from '../src/bundle-groups.ts'
import { stableReviewStateJson } from '../src/review-state.ts'
import type { ReviewEmailSummary } from '../src/shared.ts'

async function profile(size: number) {
  global.gc?.()
  const emails: ReviewEmailSummary[] = Array.from({ length: size }, (_, index) => ({
    id: `fixture-${index}`,
    threadId: `thread-${index}`,
    subject: `Synthetic notification ${index}`,
    preview: 'Generated data for local profiling. '.repeat(6),
    receivedAt: new Date(index * 1000).toISOString(),
    from: [{ name: 'Fixture', email: 'fixture@example.test' }],
    to: [],
    mailboxNames: ['Inbox'],
    hasAttachment: false,
    isNewsletter: false,
  }))
  const start = performance.now()
  const run = await buildReviewBundlesFromPartition('profile', emails, async () => ({
    stories: [],
    standaloneEmailIds: emails.map((email) => email.id),
  }))
  const buildMs = performance.now() - start
  const groups = run.bundles.map((bundle) => bundle.emailIds)
  const restoreStart = performance.now()
  restoreBundleGroups(run, groups, emails)
  const restoreMs = performance.now() - restoreStart
  const state = {
    bundleGroups: groups,
    index: 0,
    keptUnreadIds: [],
    processedIds: [],
    secondaryActionIds: [],
    selectedMemberId: emails[0]?.id,
    replyDrafts: {},
  }
  const serialization: number[] = []
  for (let iteration = 0; iteration < 5; iteration += 1) stableReviewStateJson(state)
  let payload = ''
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const time = performance.now()
    payload = stableReviewStateJson(state)
    serialization.push(performance.now() - time)
  }
  serialization.sort((left, right) => left - right)
  global.gc?.()
  const beforeBodies = process.memoryUsage().heapUsed
  const bodies = emails.map((email) =>
    `${email.id}\n${'Synthetic received body. '.repeat(1000)}`.split('').join(''),
  )
  global.gc?.()
  const retainedBodyMiB = (process.memoryUsage().heapUsed - beforeBodies) / 1024 / 1024
  console.log(
    JSON.stringify({
      size,
      buildMs: +buildMs.toFixed(1),
      restoreMs: +restoreMs.toFixed(1),
      stateP50Ms: +(serialization[10] ?? 0).toFixed(1),
      stateP95Ms: +(serialization[19] ?? 0).toFixed(1),
      stateKiB: +(Buffer.byteLength(payload) / 1024).toFixed(1),
      retainedBodyMiB: +retainedBodyMiB.toFixed(1),
      bodyCharacters: bodies[0]?.length,
    }),
  )
}

for (const size of [1000, 5000, 10000]) await profile(size)
