import type { SpaceClient } from './http.js';
import { findCommentById } from './comments.js';
import { SpaceCliError } from './errors.js';
import { asArray, asRecord, numberOrNull, prop, stringOrNull } from './json.js';
import { projectParam } from './project.js';

/*
 * Pinned live (Step 0 write-path probe, 2026-11-05 — docs/api-notes.md §5):
 * - Reply: `POST /chats/messages/send {channel, text}`. Replies are flat —
 *   no parent-message id; posting to the thread's channel IS the reply.
 * - Resolve: `PATCH .../unbound-discussions/{id}/toggle {"resolved": bool}`
 *   → 200 with an EMPTY body — the state must be read back from the list
 *   endpoint. Anchored (file/line) discussions have NO resolve API (the web
 *   UI uses a private websocket protocol); the CLI must fail with a
 *   documented platform-limitation error and not fake it.
 */

/** Stable output shape of `space-cli comments reply`. */
export interface ReplyResult {
  /** The comment (discussion) id that was replied to. */
  commentId: string;
  reviewId: string;
  /** The thread channel the reply was posted into. */
  threadChannelId: string;
  /** The posted message as Space reported it (fields may be null if Space's response is lean). */
  message: PostedMessage;
}

export interface PostedMessage {
  id: string | null;
  text: string | null;
  author: string | null;
  /** Epoch milliseconds. */
  createdAt: number | null;
}

/** Stable output shape of `space-cli comments resolve` / `unresolve`. */
export interface ResolveResult {
  commentId: string;
  reviewId: string;
  /** Thread state read back from Space after the mutation (never assumed). */
  resolved: boolean;
}

/**
 * Post `text` into the thread channel of comment `commentId` (a flat reply —
 * Space threads are chat channels; there is no parent-message id).
 * No guardrails: the message is posted exactly as given and cannot be
 * undone through this command.
 */
export async function replyToComment(
  client: SpaceClient,
  project: string,
  reviewId: string,
  commentId: string,
  text: string,
): Promise<ReplyResult> {
  const comment = await requireComment(client, project, reviewId, commentId);
  if (comment.threadChannelId === null) {
    throw new SpaceCliError(
      'protocol-error',
      `Comment ${commentId} has no thread channel id; cannot post a reply`,
    );
  }
  const raw = await client.post('/chats/messages/send', {
    channel: comment.threadChannelId,
    text,
  });
  return {
    commentId,
    reviewId,
    threadChannelId: comment.threadChannelId,
    message: parsePostedMessage(raw),
  };
}

/**
 * Resolve (`resolved: true`) or reopen (`resolved: false`) a **review-level**
 * comment thread. Anchored (file/line) threads have no resolve API in
 * Space's public REST surface — this throws a `platform-limitation` error
 * for them instead of faking success. The resulting state is read back
 * from Space and returned; a mismatch or a vanished record is a
 * `protocol-error`.
 */
export async function setCommentResolved(
  client: SpaceClient,
  project: string,
  reviewId: string,
  commentId: string,
  resolved: boolean,
): Promise<ResolveResult> {
  const comment = await requireComment(client, project, reviewId, commentId);
  if (comment.kind === 'anchored') {
    throw new SpaceCliError(
      'platform-limitation',
      `Comment ${commentId} is an anchored (file/line) thread; the Space public REST API ` +
        `only supports resolving review-level threads. Reply to the thread instead, ` +
        `or resolve it in the Space web UI.`,
    );
  }
  const projectPath = encodeURIComponent(projectParam(project));
  const reviewPath = `${projectPath}/code-reviews/${encodeURIComponent(reviewId)}`;
  await client.patch(
    `/projects/${reviewPath}/unbound-discussions/${encodeURIComponent(commentId)}/toggle`,
    { resolved },
  );
  // The toggle answers 200 with an empty body — verify via the list endpoint.
  const actual = await fetchResolvedState(client, reviewPath, commentId);
  if (actual === null) {
    throw new SpaceCliError(
      'protocol-error',
      `Resolve of comment ${commentId} returned success, but the discussion record is ` +
        `no longer listed for review ${reviewId}; state unverified`,
    );
  }
  if (actual !== resolved) {
    throw new SpaceCliError(
      'protocol-error',
      `Resolve of comment ${commentId} returned success, but Space still reports ` +
        `resolved: ${actual} (expected ${resolved}); state unverified`,
    );
  }
  return { commentId, reviewId, resolved: actual };
}

/** Look up the comment or fail with the machine-friendly not-found error. */
async function requireComment(
  client: SpaceClient,
  project: string,
  reviewId: string,
  commentId: string,
) {
  const comment = await findCommentById(client, project, reviewId, commentId);
  if (comment === null) {
    throw new SpaceCliError(
      'not-found',
      `Comment ${commentId} not found in review ${reviewId} (project ${project})`,
    );
  }
  return comment;
}

/**
 * Read `resolved` of one unbound discussion, or `null` if the record is not
 * listed. Uses the lean `$fields=data(id,resolved)` projection pinned in
 * api-notes §Resolve; pages until found or exhausted.
 */
async function fetchResolvedState(
  client: SpaceClient,
  reviewPath: string,
  commentId: string,
): Promise<boolean | null> {
  const PAGE_SIZE = 100;
  let skip = 0;
  for (;;) {
    const raw = await client.get<unknown>(`/projects/${reviewPath}/unbound-discussions`, {
      $skip: skip,
      $top: PAGE_SIZE,
      $fields: 'data(id,resolved),totalCount',
    });
    const record = asRecord(raw);
    const batch = record ? asArray(prop(record, 'data')) : [];
    const hit = batch.find((item) => stringOrNull(prop(item, 'id')) === commentId);
    if (hit !== undefined) return prop(hit, 'resolved') === true;
    if (batch.length === 0 || batch.length < PAGE_SIZE) return null;
    skip += batch.length;
  }
}

/**
 * Defensively project the `/chats/messages/send` response (its exact shape
 * is not pinned in api-notes): accept a flat message record
 * `{id, text, time, author{name}}`, Space's identifier wrapper
 * `{id: {className, id}}`, or anything leaner — missing fields come out
 * `null`; by the time this runs, the mutation itself already succeeded.
 */
function parsePostedMessage(raw: unknown): PostedMessage {
  const record = asRecord(raw);
  if (record === null) return { id: null, text: null, author: null, createdAt: null };
  const author = asRecord(prop(record, 'author'));
  return {
    id: messageIdentifierId(prop(record, 'id')),
    text: stringOrNull(prop(record, 'text')),
    author: author !== null ? stringOrNull(prop(author, 'name')) : null,
    createdAt: numberOrNull(prop(record, 'time')) ?? numberOrNull(prop(record, 'createdAt')),
  };
}

/** `"abc"` or `{className: "ChatMessageIdentifier.InternalId", id: "abc"}` → `"abc"`. */
function messageIdentifierId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return record !== null ? stringOrNull(prop(record, 'id')) : null;
}
