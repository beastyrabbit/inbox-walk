import { describe, expect, it } from 'vitest'
import { restoreBundleGroups } from '../src/bundle-groups.ts'
import { singletonBundleRun } from './bundles.ts'
import { demoEmails } from './demo.ts'

describe('restored bundle groups', () => {
  it('preserves group order, source order and chronological timelines', () => {
    const emails = demoEmails.slice(0, 3)
    const run = singletonBundleRun('fixture', emails)
    const groups = [[emails[2].id, emails[0].id], [emails[1].id]]
    const restored = restoreBundleGroups(run, groups, emails)
    expect(restored.bundles.map((bundle) => bundle.emailIds)).toEqual(groups)
    expect(restored.bundles[0].title).toBe(run.bundles[0].title)
    expect(restored.bundles[0].summary).toBe(`${run.bundles[0].summary} ${run.bundles[2].summary}`)
    expect(restored.bundles[0].timeline.map((item) => item.emailId)).toEqual([
      emails[2].id,
      emails[0].id,
    ])
    expect(restoreBundleGroups(run, [[emails[0].id]], emails)).toBe(run)
  })
})
