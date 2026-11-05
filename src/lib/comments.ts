import type { SpaceClient } from './http.js';
import { SpaceCliError } from './errors.js';
import { asArray, asRecord, numberOrNull, prop, stringOrNull } from './json.js';
import { projectParam } from './project.js';

/**
 * Stable output schema for `space-cli comments list` (see PLAN.md §5).
 * Each comment is a thread root: the original comment plus its replies.
 */
export interface Comment {
  /** Space CodeDiscussionRecord id — the id used by reply/resolve (M4). */
  id: string;
  /** Review record id the comment belongs to. */
  reviewId: string;
  /** Chat channel backing this thread (replies are posted here in M4). */
  threadChannelId: string | null;
  /** `anchored` (file/line) | `review-level` (unbound, whole-review). */
  kind: 'anchored' | 'review-level';
  /** Root comment author (principal username, e.g. `Alexander.Gusakov`). */
  author: string | null;
  /** Epoch milliseconds of the root comment. */
  createdAt: number | null;
  /** Root comment text. */
  text: string | null;
  /** Live thread state — Space resolves whole threads, not single messages. */
  resolved: boolean;
  /**
   * `true` when anchor.revision differs from the review head. `null` until
   * M3 wires the revision comparison; agents must not rely on it yet.
   */
  outdated: boolean | null;
  /** Present for `anchored` comments; `null` for review-level ones. */
  anchor: CommentAnchor | null;
  /** Chronological replies after the root comment. */
  replies: CommentReply[];
}

export interface CommentAnchor {
  /** File path with Space's leading `/` normalized away. */
  file: string;
  repository: string | null;
  /** Right-side (new) coordinate; `null` for review-level comments. */
  line: number | null;
  /** Left-side (old) coordinate; `null` for pure additions. */
  oldLine: number | null;
  /** Commit the comment is anchored to. */
  revision: string | null;
  /** Space's built-in snippet (what the reviewer saw), old/new line numbers included. */
  snippet: SnippetLine[];
}

export interface SnippetLine {
  text: string | null;
  oldLineNum: number | null;
  newLineNum: number | null;
}

export interface CommentReply {
  id: string;
  author: string | null;
  /** Epoch milliseconds. */
  createdAt: number | null;
  text: string | null;
}

export interface CommentFilters {
  /** Only anchored comments on this exact file path (leading `/` tolerated). */
  file?: string;
  /** Only threads whose root comment author (username) equals this, exactly. */
  author?: string;
  /** Only unresolved threads. */
  unresolved?: boolean;
}

/*
 * Pinned live (M2 probe, 2026-11-05, jetbrains.team):
 * - `chats/messages` WITHOUT `$fields` returns id-only messages — the
 *   projections below are mandatory, and `nextStartFromDate` must be listed
 *   in the projection or it is stripped too.
 * - Continuation: response `nextStartFromDate.iso` feeds the next request's
 *   `startFromDate` (ISO date-time string). A full batch (== batchSize) means
 *   "there may be more"; a short batch ends the loop.
 * - `batchSize` is hard-capped at 50 by the server.
 */
const FEED_FIELDS =
  'messages(id,details(className,codeDiscussion(id,anchor(repository,revision,filename,line,oldLine),channel(id),resolvable,resolved,snippet(lines(text,oldLineNum,newLineNum))))),nextStartFromDate';
const THREAD_FIELDS = 'messages(id,time,text,author(name)),nextStartFromDate';
const UNBOUND_FIELDS = 'data(id,resolved,item(id,text,time,author(name))),totalCount';
const BATCH_SIZE = 50;
const UNBOUND_PAGE_SIZE = 100;

/**
 * List all comment threads of a review: anchored (file/line) discussions
 * discovered through the review's feed channel, plus review-level (unbound)
 * discussions from the dedicated endpoint. Threads are merged and sorted
 * chronologically, then filtered.
 *
 * Cost: 2 + N requests (feed pages + one message fetch per discussion thread
 * + unbound pages). Verified live that Space applies no rate limits at this
 * request volume.
 */
export async function listComments(
  client: SpaceClient,
  project: string,
  reviewId: string,
  filters: CommentFilters = {},
): Promise<Comment[]> {
  const projectPath = encodeURIComponent(projectParam(project));
  const reviewPath = `${projectPath}/code-reviews/${encodeURIComponent(reviewId)}`;

  const feedChannelId = await fetchFeedChannelId(client, reviewPath, reviewId);

  const anchored: Comment[] = [];
  for (const discussion of await fetchFeedDiscussions(client, feedChannelId)) {
    if (discussion.channelId === null) {
      throw new SpaceCliError(
        'protocol-error',
        `Discussion ${discussion.id} has no thread channel id; cannot read its messages`,
      );
    }
    const messages = await fetchChannelMessages(client, discussion.channelId, THREAD_FIELDS);
    anchored.push(toAnchoredComment(discussion, messages, reviewId));
  }

  const reviewLevel = await fetchReviewLevelComments(client, reviewPath, reviewId, feedChannelId);

  let comments = [...anchored, ...reviewLevel].sort(
    (a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER),
  );
  if (filters.file !== undefined) {
    const file = normalizeFilePath(filters.file);
    comments = comments.filter((c) => c.anchor !== null && c.anchor.file === file);
  }
  if (filters.author !== undefined) {
    comments = comments.filter((c) => c.author === filters.author);
  }
  if (filters.unresolved) {
    comments = comments.filter((c) => !c.resolved);
  }
  return comments;
}

/** The review's timeline feed channel id — the discovery surface for discussions. */
async function fetchFeedChannelId(
  client: SpaceClient,
  reviewPath: string,
  reviewId: string,
): Promise<string> {
  const raw = await client.get<unknown>(`/projects/${reviewPath}`, { $fields: 'feedChannelId' });
  if (raw === null || raw === undefined) {
    throw new SpaceCliError('not-found', `Review ${reviewId} not found`);
  }
  const record = asRecord(raw);
  const feedChannelId = record ? stringOrNull(prop(record, 'feedChannelId')) : null;
  if (feedChannelId === null) {
    throw new SpaceCliError(
      'protocol-error',
      `Review ${reviewId} has no feed channel id; cannot list its comments`,
    );
  }
  return feedChannelId;
}

interface RawDiscussion {
  id: string;
  channelId: string | null;
  resolved: boolean;
  anchor: Record<string, unknown> | null;
  snippet: Record<string, unknown> | null;
}

/**
 * Walk the review's feed channel and collect the latest live record of every
 * code discussion mentioned by a `CodeDiscussionAddedFeedEvent` (deduped by
 * id; a later event for the same id wins).
 */
async function fetchFeedDiscussions(
  client: SpaceClient,
  feedChannelId: string,
): Promise<RawDiscussion[]> {
  const byId = new Map<string, RawDiscussion>();
  for (const message of await fetchChannelMessages(client, feedChannelId, FEED_FIELDS)) {
    const details = asRecord(prop(message, 'details'));
    if (details === null || stringOrNull(prop(details, 'className')) !== 'CodeDiscussionAddedFeedEvent') {
      continue;
    }
    const discussion = asRecord(prop(details, 'codeDiscussion'));
    if (discussion === null) continue;
    const id = stringOrNull(prop(discussion, 'id'));
    const channel = asRecord(prop(discussion, 'channel'));
    byId.set(id ?? '', {
      id: id ?? '',
      channelId: channel ? stringOrNull(prop(channel, 'id')) : null,
      resolved: prop(discussion, 'resolved') === true,
      anchor: asRecord(prop(discussion, 'anchor')),
      snippet: asRecord(prop(discussion, 'snippet')),
    });
  }
  return [...byId.values()].filter((d) => d.id !== '');
}

/**
 * Fetch all messages of a chat channel, oldest first, following
 * `nextStartFromDate` → `startFromDate` continuation while the server
 * keeps returning full batches.
 */
async function fetchChannelMessages(
  client: SpaceClient,
  channelId: string,
  fields: string,
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  let startFromDate: string | undefined;
  for (;;) {
    const raw = await client.get<unknown>('/chats/messages', {
      channel: channelId,
      sorting: 'FromOldestToNewest',
      batchSize: BATCH_SIZE,
      startFromDate,
      $fields: fields,
    });
    const record = asRecord(raw);
    const batch = record ? asArray(prop(record, 'messages')) : [];
    messages.push(...batch);
    if (batch.length < BATCH_SIZE) break;
    const next = record ? asRecord(prop(record, 'nextStartFromDate')) : null;
    const nextIso = next ? stringOrNull(prop(next, 'iso')) : null;
    if (nextIso === null) break;
    startFromDate = nextIso;
  }
  return messages;
}

function toAnchoredComment(
  discussion: RawDiscussion,
  messages: Record<string, unknown>[],
  reviewId: string,
): Comment {
  const root = messages.length > 0 ? messages[0]! : null;
  const snippetRecord = discussion.snippet;
  const snippetLines = snippetRecord ? asArray(prop(snippetRecord, 'lines')) : [];
  const anchor = discussion.anchor;
  return {
    id: discussion.id,
    reviewId,
    threadChannelId: discussion.channelId,
    kind: 'anchored',
    author: root ? messageAuthor(root) : null,
    createdAt: root ? numberOrNull(prop(root, 'time')) : null,
    text: root ? stringOrNull(prop(root, 'text')) : null,
    resolved: discussion.resolved,
    outdated: null,
    anchor:
      anchor !== null
        ? {
            file: normalizeFilePath(stringOrNull(prop(anchor, 'filename')) ?? ''),
            repository: stringOrNull(prop(anchor, 'repository')),
            line: numberOrNull(prop(anchor, 'line')),
            oldLine: numberOrNull(prop(anchor, 'oldLine')),
            revision: stringOrNull(prop(anchor, 'revision')),
            snippet: snippetLines.map((line) => ({
              text: stringOrNull(prop(line, 'text')),
              oldLineNum: numberOrNull(prop(line, 'oldLineNum')),
              newLineNum: numberOrNull(prop(line, 'newLineNum')),
            })),
          }
        : null,
    replies: messages.slice(1).map(toReply),
  };
}

/**
 * Review-level (unbound) discussions from the dedicated endpoint.
 * Their "thread" is the review channel itself; v1 does not reconstruct
 * reply chains for them (replies: []), only the root comment is reported.
 */
async function fetchReviewLevelComments(
  client: SpaceClient,
  reviewPath: string,
  reviewId: string,
  feedChannelId: string,
): Promise<Comment[]> {
  const comments: Comment[] = [];
  let skip = 0;
  for (;;) {
    const raw = await client.get<unknown>(`/projects/${reviewPath}/unbound-discussions`, {
      $skip: skip,
      $top: UNBOUND_PAGE_SIZE,
      $fields: UNBOUND_FIELDS,
    });
    const record = asRecord(raw);
    const batch = record ? asArray(prop(record, 'data')) : [];
    for (const item of batch) {
      const comment = unboundToComment(item, reviewId, feedChannelId);
      if (comment !== null) comments.push(comment);
    }
    if (batch.length === 0 || batch.length < UNBOUND_PAGE_SIZE) break;
    skip += batch.length;
  }
  return comments;
}

function unboundToComment(
  raw: Record<string, unknown>,
  reviewId: string,
  feedChannelId: string,
): Comment | null {
  const id = stringOrNull(prop(raw, 'id'));
  const item = asRecord(prop(raw, 'item'));
  const text = item ? stringOrNull(prop(item, 'text')) : null;
  const author = item ? messageAuthor(item) : null;
  // Ghost filter (pinned live): deleting the backing chat message (the only
  // REST cleanup available) leaves the discussion record behind with an
  // empty text AND empty author. Those are API debris, not comments.
  if (id !== null && (text !== null && text !== '' || author !== null && author !== '')) {
    return {
      id,
      reviewId,
      threadChannelId: feedChannelId,
      kind: 'review-level',
      author,
      createdAt: item ? numberOrNull(prop(item, 'time')) : null,
      text,
      resolved: prop(raw, 'resolved') === true,
      outdated: null,
      anchor: null,
      replies: [],
    };
  }
  return null;
}

function messageAuthor(message: Record<string, unknown>): string | null {
  const author = asRecord(prop(message, 'author'));
  return author ? stringOrNull(prop(author, 'name')) : null;
}

function toReply(message: Record<string, unknown>): CommentReply {
  return {
    id: stringOrNull(prop(message, 'id')) ?? '',
    author: messageAuthor(message),
    createdAt: numberOrNull(prop(message, 'time')),
    text: stringOrNull(prop(message, 'text')),
  };
}

/** Space anchors file paths with a leading `/`; normalize it away. */
export function normalizeFilePath(path: string): string {
  return path.replace(/^\//, '');
}
