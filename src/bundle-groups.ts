import type { ReviewBundle, ReviewBundleRun, ReviewSnapshot } from './shared.ts'

export function restoreBundleGroups(
  run: ReviewBundleRun,
  groups: readonly (readonly string[])[],
  emails: ReviewSnapshot['emails'],
) {
  const expected = new Set(emails.map((email) => email.id))
  const restoredIds = groups.flat()
  if (
    restoredIds.length !== expected.size ||
    new Set(restoredIds).size !== expected.size ||
    restoredIds.some((id) => !expected.has(id))
  ) {
    return run
  }
  const timelineById = new Map(
    run.bundles.flatMap((bundle) => bundle.timeline.map((item) => [item.emailId, item] as const)),
  )
  const emailById = new Map(emails.map((email) => [email.id, email]))
  const bundleOrdinalByEmail = new Map(
    run.bundles.flatMap((bundle, ordinal) => bundle.emailIds.map((id) => [id, ordinal] as const)),
  )
  return {
    ...run,
    bundles: groups.map((group, groupIndex) => {
      const sources = [
        ...new Set(
          group
            .map((id) => bundleOrdinalByEmail.get(id))
            .filter((ordinal): ordinal is number => ordinal !== undefined),
        ),
      ]
        .sort((left, right) => left - right)
        .map((ordinal) => run.bundles[ordinal] as ReviewBundle)
      const primary = sources[0]
      const original = emailById.get(group[0] ?? '')
      return {
        bundleId: `restored-${groupIndex}-${group[0]}`,
        currentState:
          group.length === 1 ? 'Einzelne Nachricht' : (primary?.currentState ?? 'Letzter Stand'),
        emailIds: [...group],
        kind: group.length === 1 ? 'standalone' : (primary?.kind ?? 'standalone'),
        linkEvidence: [...new Set(sources.flatMap((bundle) => bundle.linkEvidence))],
        membershipConfidence: 1,
        summary:
          group.length === 1
            ? original?.preview || original?.subject || ''
            : sources.map((bundle) => bundle.summary).join(' '),
        timeline: group
          .map((id) => timelineById.get(id))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)),
        title:
          group.length === 1
            ? original?.subject || '(Kein Betreff)'
            : primary?.title || original?.subject || '(Kein Betreff)',
      } satisfies ReviewBundle
    }),
  }
}
