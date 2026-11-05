import type { SpaceClient } from './http.js';
import { SpaceCliError } from './errors.js';
import { asArray, asRecord, numberOrNull, prop, stringOrNull } from './json.js';
import { projectParam } from './project.js';

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

/** Leaner schema for `reviews list` items (see ReviewListResult). */
export interface ReviewSummary {
  id: string;
  kind: 'mergeRequest' | 'commitSetReview';
  number: number | null;
  title: string | null;
  state: string | null;
  /** Epoch milliseconds. Commit-set reviews report `0` in list responses — normalized to null. */
  createdAt: number | null;
  repository: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  discussionCounter: DiscussionCounter | null;
}

export interface ReviewListFilters {
  /** Opened | Closed | RequiresAuthorAttention | NeedsReview | Merged */
  state?: string;
  /** Full-text query over review titles. */
  text?: string;
  /** Author profile id (not username — resolve via Space team directory). */
  author?: string;
  /** Reviewer profile id (not username). */
  reviewer?: string;
  /** Repository name inside the project. */
  repository?: string;
}

export interface ReviewListResult {
  /** Total reviews matching the filters (independent of `limit`). */
  totalCount: number;
  reviews: ReviewSummary[];
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
    `/projects/${encodeURIComponent(projectParam(project))}/code-reviews/${encodeURIComponent(reviewId)}`,
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

/**
 * List code reviews, following offset pagination (`$skip`/`$top`) until
 * `limit` items are collected or the server runs dry.
 *
 * Pinned live (M2 probe, 2026-11-05): the list projection tolerates
 * `branchPair` (whole or with nested subfield names); commit-set review
 * items legitimately have no `branchPair` and report `createdAt: 0`.
 */
const LIST_FIELDS =
  'data(review(id,number,title,state,createdAt,discussionCounter,branchPair)),totalCount';
const LIST_PAGE_SIZE = 100;
export const DEFAULT_LIST_LIMIT = 25;

export async function listReviews(
  client: SpaceClient,
  project: string,
  filters: ReviewListFilters = {},
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<ReviewListResult> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new SpaceCliError('usage-error', `--limit must be a positive integer, got ${limit}`);
  }
  const reviews: ReviewSummary[] = [];
  let totalCount: number | null = null;
  let skip = 0;
  while (reviews.length < limit) {
    const top = Math.min(LIST_PAGE_SIZE, limit - reviews.length);
    const raw = await client.get<unknown>(
      `/projects/${encodeURIComponent(projectParam(project))}/code-reviews`,
      {
        state: filters.state,
        text: filters.text,
        author: filters.author,
        reviewer: filters.reviewer,
        repository: filters.repository,
        $skip: skip,
        $top: top,
        $fields: LIST_FIELDS,
      },
    );
    const page = asRecord(raw);
    const items = asArray(page ? prop(page, 'data') : undefined);
    if (totalCount === null && page) {
      totalCount = numberOrNull(prop(page, 'totalCount'));
    }
    if (items.length === 0) break;
    reviews.push(...items.map((item) => normalizeReviewSummary(prop(item, 'review'))));
    skip += items.length;
  }
  // The server is expected to honor $top; truncate defensively in case it
  // returns more than asked (observed only in mocked tests so far).
  return { totalCount: totalCount ?? reviews.length, reviews: reviews.slice(0, limit) };
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
    repository: branchPair ? stringOrNull(prop(branchPair, 'repository')) : null,
    sourceBranch: branchPair ? stringOrNull(prop(branchPair, 'sourceBranch')) : null,
    targetBranch: branchPair ? stringOrNull(prop(branchPair, 'targetBranch')) : null,
    authors,
    reviewers: asArray(raw.reviewers)
      .map((r) => userId(r))
      .filter((id): id is string => id !== null),
    discussionCounter: counter
      ? {
          resolved: numberOrNull(prop(counter, 'resolved')) ?? 0,
          unresolved: numberOrNull(prop(counter, 'unresolved')) ?? 0,
          unresolvedSuggestedEdits: numberOrNull(prop(counter, 'unresolvedSuggestedEdits')) ?? 0,
          acceptedSuggestedEdits: numberOrNull(prop(counter, 'acceptedSuggestedEdits')) ?? 0,
          rejectedSuggestedEdits: numberOrNull(prop(counter, 'rejectedSuggestedEdits')) ?? 0,
        }
      : null,
    commits: asArray(raw.commits).map((c) => ({
      repositoryId: stringOrNull(prop(c, 'repositoryId')),
      commitId: stringOrNull(prop(c, 'commitId')),
    })),
  };
}

export function normalizeReviewSummary(raw: unknown): ReviewSummary {
  const record = asRecord(raw);
  if (record === null) {
    throw new SpaceCliError('protocol-error', 'reviews list returned an item without a review record');
  }
  const className = stringOrNull(prop(record, 'className'));
  if (className !== 'MergeRequestRecord' && className !== 'CommitSetReviewRecord') {
    throw new SpaceCliError(
      'protocol-error',
      `unexpected review record className: ${JSON.stringify(className)}`,
    );
  }
  const branchPair = asRecord(prop(record, 'branchPair'));
  const counter = asRecord(prop(record, 'discussionCounter'));
  // Commit-set review list items report createdAt: 0 (epoch 1970 is never real).
  const createdAt = numberOrNull(prop(record, 'createdAt'));
  return {
    id: stringOrNull(prop(record, 'id')) ?? '',
    kind: className === 'MergeRequestRecord' ? 'mergeRequest' : 'commitSetReview',
    number: numberOrNull(prop(record, 'number')),
    title: stringOrNull(prop(record, 'title')),
    state: stringOrNull(prop(record, 'state')),
    createdAt: createdAt !== null && createdAt > 0 ? createdAt : null,
    repository: branchPair ? stringOrNull(prop(branchPair, 'repository')) : null,
    sourceBranch: branchPair ? stringOrNull(prop(branchPair, 'sourceBranch')) : null,
    targetBranch: branchPair ? stringOrNull(prop(branchPair, 'targetBranch')) : null,
    discussionCounter: counter
      ? {
          resolved: numberOrNull(prop(counter, 'resolved')) ?? 0,
          unresolved: numberOrNull(prop(counter, 'unresolved')) ?? 0,
          unresolvedSuggestedEdits: numberOrNull(prop(counter, 'unresolvedSuggestedEdits')) ?? 0,
          acceptedSuggestedEdits: numberOrNull(prop(counter, 'acceptedSuggestedEdits')) ?? 0,
          rejectedSuggestedEdits: numberOrNull(prop(counter, 'rejectedSuggestedEdits')) ?? 0,
        }
      : null,
  };
}

/** Profile id from a `{ user: { id } }` participant/reviewer shape. */
function userId(value: Record<string, unknown>): string | null {
  const user = asRecord(prop(value, 'user'));
  return user ? stringOrNull(prop(user, 'id')) : null;
}
