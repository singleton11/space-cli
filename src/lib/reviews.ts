import type { SpaceClient } from './http.js';
import { SpaceCliError } from './errors.js';

/** Stable output schema for `space-cli reviews show` (see PLAN.md §5). */
export interface Review {
  /** Space review record id (stable machine id; not the human-visible number). */
  id: string;
  /** `mergeRequest` | `commitSetReview` — from the record's className. */
  kind: 'mergeRequest' | 'commitSetReview';
  /** Human-visible review number. */
  number: number | null;
  title: string | null;
  /** Opened | Closed | RequiresAuthorAttention | NeedsReview | Merged */
  state: string | null;
  /** Epoch milliseconds. */
  createdAt: number | null;
  /** Review timeline chat channel — the read path for discussions. */
  feedChannelId: string | null;
  /** From branchPair (merge requests only); null for commit-set reviews. */
  repository: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  /** Participant profile ids with role "Author". */
  authors: string[];
  /** Reviewer profile ids. */
  reviewers: string[];
  discussionCounter: DiscussionCounter | null;
  commits: ReviewCommit[];
}

export interface DiscussionCounter {
  resolved: number;
  unresolved: number;
  unresolvedSuggestedEdits: number;
  acceptedSuggestedEdits: number;
  rejectedSuggestedEdits: number;
}

export interface ReviewCommit {
  repositoryId: string | null;
  commitId: string | null;
}

/**
 * Fetch one review by record id.
 * Pinned in Step 0 + M1: `GET /projects/{project}/code-reviews/{reviewId}`
 * returns a minimal record by default — the full shape (participants,
 * reviewers, discussionCounter, commits) requires this `$fields` projection,
 * verified live 2026-11-05. A missing review returns HTTP 200 with a `null`
 * body, which we map to `not-found`.
 */
const REVIEW_FIELDS =
  'id,number,title,state,createdAt,feedChannelId,branchPair,participants,reviewers,discussionCounter,commits';

export async function getReview(
  client: SpaceClient,
  project: string,
  reviewId: string,
): Promise<Review> {
  const raw = await client.get<unknown>(
    `/projects/${encodeURIComponent(project)}/code-reviews/${encodeURIComponent(reviewId)}`,
    { $fields: REVIEW_FIELDS },
  );
  if (raw === null || raw === undefined) {
    throw new SpaceCliError('not-found', `Review ${reviewId} not found in project ${project}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpaceCliError(
      'protocol-error',
      `Space returned an unexpected body for review ${reviewId} in project ${project}`,
    );
  }
  return normalizeReview(raw as Record<string, unknown>);
}

export function normalizeReview(raw: Record<string, unknown>): Review {
  const className = typeof raw.className === 'string' ? raw.className : '';
  if (className !== 'MergeRequestRecord' && className !== 'CommitSetReviewRecord') {
    throw new SpaceCliError(
      'protocol-error',
      `unexpected review record className: ${JSON.stringify(className ?? raw.className)}`,
    );
  }

  const participants = asArray(raw.participants);
  const authors = participants
    .filter((p) => prop(p, 'role') === 'Author')
    .map((p) => userId(p))
    .filter((id): id is string => id !== null);

  const branchPair = asRecord(raw.branchPair);
  const counter = asRecord(raw.discussionCounter);

  return {
    id: stringOrNull(raw.id) ?? '',
    kind: className === 'MergeRequestRecord' ? 'mergeRequest' : 'commitSetReview',
    number: numberOrNull(raw.number),
    title: stringOrNull(raw.title),
    state: stringOrNull(raw.state),
    createdAt: numberOrNull(raw.createdAt),
    feedChannelId: stringOrNull(raw.feedChannelId),
    repository: branchPair ? stringOrNull(branchPair.repository) : null,
    sourceBranch: branchPair ? stringOrNull(branchPair.sourceBranch) : null,
    targetBranch: branchPair ? stringOrNull(branchPair.targetBranch) : null,
    authors,
    reviewers: asArray(raw.reviewers)
      .map((r) => userId(r))
      .filter((id): id is string => id !== null),
    discussionCounter: counter
      ? {
          resolved: numberOrNull(counter.resolved) ?? 0,
          unresolved: numberOrNull(counter.unresolved) ?? 0,
          unresolvedSuggestedEdits: numberOrNull(counter.unresolvedSuggestedEdits) ?? 0,
          acceptedSuggestedEdits: numberOrNull(counter.acceptedSuggestedEdits) ?? 0,
          rejectedSuggestedEdits: numberOrNull(counter.rejectedSuggestedEdits) ?? 0,
        }
      : null,
    commits: asArray(raw.commits).map((c) => ({
      repositoryId: stringOrNull(prop(c, 'repositoryId')),
      commitId: stringOrNull(prop(c, 'commitId')),
    })),
  };
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function prop(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

/** Profile id from a `{ user: { id } }` participant/reviewer shape. */
function userId(value: Record<string, unknown>): string | null {
  const user = asRecord(prop(value, 'user'));
  return user ? stringOrNull(prop(user, 'id')) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
