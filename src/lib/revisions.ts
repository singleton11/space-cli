import type { SpaceClient } from './http.js';
import { asArray, asRecord, asStringArray, numberOrNull, prop, stringOrNull } from './json.js';

/**
 * Where a review currently stands in one repository — the reference points
 * `outdated` compares anchors against.
 */
export interface RepositoryRevisions {
  /** Newest in-review commit: what right-side (new) anchors are compared against. */
  head: string | null;
  /**
   * Parent of the review's first commit: what left-side (old) anchors are
   * compared against. `null` when the review's commits in this repository
   * don't form a single chain (commit-set reviews of disjoint commits).
   */
  base: string | null;
}

/*
 * Pinned live (M3 probe, 2026-11-05, jetbrains.team):
 * `GET .../code-reviews/{id}/details` returns every in-review commit with its
 * parents, grouped by repository name, for both merge requests and commit-set
 * reviews. The order is not topological, so head/base are derived from the
 * commit graph. For merge requests the derived head equals
 * `branchPair.sourceBranchRef` (verified on 14 MRs).
 */
const DETAILS_FIELDS = 'commits(repository(name),commits(commit(id,parents,commitDate)))';

export async function fetchReviewRevisions(
  client: SpaceClient,
  reviewPath: string,
): Promise<Map<string, RepositoryRevisions>> {
  const raw = await client.get<unknown>(`/projects/${reviewPath}/details`, { $fields: DETAILS_FIELDS });
  return reviewRevisionsFromDetails(raw);
}

/** Head/base per repository name, from a `details` response under DETAILS_FIELDS. */
export function reviewRevisionsFromDetails(raw: unknown): Map<string, RepositoryRevisions> {
  const result = new Map<string, RepositoryRevisions>();
  const record = asRecord(raw);
  for (const group of asArray(record ? prop(record, 'commits') : undefined)) {
    const repository = asRecord(prop(group, 'repository'));
    const name = repository ? stringOrNull(prop(repository, 'name')) : null;
    if (name === null) continue;
    const commits = asArray(prop(group, 'commits'))
      .map((c) => asRecord(prop(c, 'commit')))
      .filter((c): c is Record<string, unknown> => c !== null)
      .map((c) => ({
        id: stringOrNull(prop(c, 'id')),
        commitDate: numberOrNull(prop(c, 'commitDate')) ?? 0,
        parents: asStringArray(prop(c, 'parents')),
      }))
      .filter((c): c is { id: string; commitDate: number; parents: string[] } => c.id !== null);
    result.set(name, headAndBase(commits));
  }
  return result;
}

function headAndBase(commits: { id: string; commitDate: number; parents: string[] }[]): RepositoryRevisions {
  const ids = new Set(commits.map((c) => c.id));
  const parentsInReview = new Set(commits.flatMap((c) => c.parents).filter((p) => ids.has(p)));
  // Tips: in-review commits no other in-review commit builds on. A chain has
  // one; a commit-set review of disjoint commits has several — take the newest.
  const tips = commits.filter((c) => !parentsInReview.has(c.id));
  const head = tips.reduce<(typeof commits)[number] | null>(
    (best, c) => (best === null || c.commitDate > best.commitDate ? c : best),
    null,
  );
  const roots = commits.filter((c) => c.parents.every((p) => !ids.has(p)));
  const base = roots.length === 1 ? (roots[0]!.parents[0] ?? null) : null;
  return { head: head?.id ?? null, base };
}
