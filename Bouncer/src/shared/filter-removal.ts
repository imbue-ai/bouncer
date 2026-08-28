// Pure decision logic for what to do with a previously-filtered post when one
// or more rules are removed from the active filter set. Lives in /shared (no
// DOM, no chrome) so it can be unit-tested without the content-script harness.
//
// Inputs reflect the stored snapshot from when the post was originally hidden:
//   - storedMatches: every category the classifier matched, or null if the
//     classifier only surfaced its best match (API path — incomplete).
//   - storedCategory: the comma-joined category string from the snapshot;
//     consulted only in the incomplete-classifier branch.
//   - removedLc: lowercase set of phrases being removed in this operation.
//
// The four outcomes:
//   - 'unaffected': none of the removed phrases match this post's stored
//     matches/category, so leave it as-is.
//   - 'restore':    every category that kept this post hidden is being
//     removed; un-hide without consulting the model.
//   - 'refresh':    some but not all of the post's matches are being removed;
//     it stays hidden under the remaining matches, but its visible
//     category/badges need updating.
//   - 'reevaluate': the classifier was incomplete and its single known
//     category is in the removed set; only the model can tell us whether
//     another remaining rule would still fire.

export type FilterRemovalDecision =
  | { kind: 'unaffected' }
  | { kind: 'restore' }
  | { kind: 'refresh'; remaining: string[] }
  | { kind: 'reevaluate' };

export function decideFilterRemoval(
  storedMatches: string[] | null,
  storedCategory: string | null,
  removedLc: ReadonlySet<string>,
): FilterRemovalDecision {
  if (storedMatches !== null) {
    const remaining = storedMatches.filter(m => !removedLc.has(m.toLowerCase()));
    if (remaining.length === storedMatches.length) return { kind: 'unaffected' };
    if (remaining.length === 0) return { kind: 'restore' };
    return { kind: 'refresh', remaining };
  }
  if (storedCategory && removedLc.has(storedCategory.toLowerCase())) {
    return { kind: 'reevaluate' };
  }
  return { kind: 'unaffected' };
}
