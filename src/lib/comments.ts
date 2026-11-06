import type { SpaceClient } from './http.js';
import { buildDiffContext, isOutdated } from './anchors.js';
import { mapWithConcurrency } from './concurrency.js';
import { SpaceCliError } from './errors.js';
import { RepositoryFiles } from './files.js';
import { asArray, asRecord, numberOrNull, prop, stringOrNull } from './json.js';
import { projectParam } from './project.js';
import { fetchReviewRevisions } from './revisions.js';

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
   * Anchored comments: `false` guarantees the commented file is byte-identical
   * at the current review head (base, for left-side anchors), so the anchor's
   * line numbers are exact today. `true` means it changed, moved, or was
   * deleted since the comment — locate the code via `snippet` text.
   * `null` for review-level comments (nothing to be outdated).
   */
  outdated: boolean | null;
  /** Present for `anchored` comments; `null` for review-level ones. */
  anchor: CommentAnchor | null;
  /** Chronological replies after the root comment. */
  replies: CommentReply[];
}

/**
 * All line numbers in the output are 1-based (editor / `grep -n` numbering).
 * Space itself counts from 0 (pinned in M3) — the CLI converts.
 */
export interface CommentAnchor {
  /** File path with Space's leading `/` normalized away. */
  file: string;
  repository: string | null;
  /** Right-side (new file) line; `null` for left-side anchors. */
  line: number | null;
  /** Left-side (old file) line, set when the comment is on a deleted line; else `null`. */
  oldLine: number | null;
  /** Commit of the side the anchor points into — the file `line`/`oldLine` index. */
  revision: string | null;
  /** Last line of a multi-line range comment; `null` for single-line comments. */
  end: AnchorEnd | null;
  /** Space's built-in snippet (what the reviewer saw), old/new line numbers included. */
  snippet: SnippetLine[];
  /**
   * Only with `--diff-context N`: the file at `revision`, N lines around the
   * anchored line(s). `null` when unavailable (binary or missing file).
   */
  diffContext?: DiffContext | null;
}

/** Same coordinate scheme as the anchor; a range may end on the other diff side. */
export interface AnchorEnd {
  line: number | null;
  oldLine: number | null;
  revision: string | null;
}

export interface DiffContext {
  /** Commit the content was read at (always `anchor.revision`). */
  revision: string;
  /** `new` when the lines are right-side (`line`) numbers, `old` for left-side (`oldLine`). */
  side: 'new' | 'old';
  lines: ContextLine[];
}

export interface ContextLine {
  line: number;
  text: string;
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

export interface CommentListOptions {
  /** Attach `anchor.diffContext` with this many lines around each anchor. */
  diffContext?: number;
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
  'messages(id,details(className,codeDiscussion(id,anchor(repository,revision,filename,line,oldLine),endAnchor(revision,line,oldLine),channel(id),resolvable,resolved,snippet(lines(text,oldLineNum,newLineNum))))),nextStartFromDate';
const THREAD_FIELDS = 'messages(id,time,text,author(name)),nextStartFromDate';
const UNBOUND_FIELDS = 'data(id,resolved,item(id,text,time,author(name))),totalCount';
const BATCH_SIZE = 50;
const UNBOUND_PAGE_SIZE = 100;
/** Parallel file lookups while enriching anchors (`outdated`, `diffContext`). */
const FILE_CONCURRENCY = 8;

/**
 * List all comment threads of a review: anchored (file/line) discussions
 * discovered through the review's feed channel, plus review-level (unbound)
 * discussions from the dedicated endpoint. Threads are merged and sorted
 * chronologically, then filtered.
 *
 * Anchored comments that survive the filters are then enriched: `outdated`
 * (always) and `anchor.diffContext` (with `options.diffContext`).
 *
 * Cost: 2 + N requests (feed pages + one message fetch per discussion thread
 * + unbound pages), plus for enrichment one `details` request and, per
 * distinct file, ≤ 2 cheap blob lookups (+ one text fetch per distinct
 * file/revision with `diffContext`). Verified live that Space applies no
 * rate limits at this request volume.
 */
export async function listComments(
  client: SpaceClient,
  project: string,
  reviewId: string,
  filters: CommentFilters = {},
  options: CommentListOptions = {},
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
  return enrichAnchors(client, projectPath, reviewPath, comments, options);
}

/**
 * Locate a single comment thread by its discussion id — the id M4's
 * reply/resolve/unresolve take as `--comment`. Walks the same discovery
 * surfaces as {@link listComments} (feed channel + unbound-discussions;
 * there is no get-discussion-by-id REST endpoint) but skips anchor
 * enrichment, so `outdated` is `null` and `anchor.diffContext` is absent.
 *
 * Returns `null` when the review exists but has no such comment.
 */
export async function findCommentById(
  client: SpaceClient,
  project: string,
  reviewId: string,
  commentId: string,
): Promise<Comment | null> {
  const projectPath = encodeURIComponent(projectParam(project));
  const reviewPath = `${projectPath}/code-reviews/${encodeURIComponent(reviewId)}`;

  const feedChannelId = await fetchFeedChannelId(client, reviewPath, reviewId);

  for (const discussion of await fetchFeedDiscussions(client, feedChannelId)) {
    if (discussion.id !== commentId) continue;
    if (discussion.channelId === null) {
      throw new SpaceCliError(
        'protocol-error',
        `Discussion ${discussion.id} has no thread channel id; cannot read its messages`,
      );
    }
    const messages = await fetchChannelMessages(client, discussion.channelId, THREAD_FIELDS);
    return toAnchoredComment(discussion, messages, reviewId);
  }

  const reviewLevel = await fetchReviewLevelComments(client, reviewPath, reviewId, feedChannelId);
  return reviewLevel.find((c) => c.id === commentId) ?? null;
}

async function enrichAnchors(
  client: SpaceClient,
  projectPath: string,
  reviewPath: string,
  comments: Comment[],
  options: CommentListOptions,
): Promise<Comment[]> {
  if (!comments.some((c) => c.anchor !== null)) return comments;
  const revisions = await fetchReviewRevisions(client, reviewPath);
  const files = new RepositoryFiles(client, projectPath);
  return mapWithConcurrency(comments, FILE_CONCURRENCY, async (comment) => {
    const anchor = comment.anchor;
    if (anchor === null) return comment;
    const outdated = await isOutdated(anchor, revisions, files);
    if (options.diffContext === undefined) return { ...comment, outdated };
    let diffContext: DiffContext | null = null;
    if (anchor.repository !== null && anchor.revision !== null) {
      const lines = await files.textLines(anchor.repository, anchor.revision, anchor.file);
      diffContext = lines === null ? null : buildDiffContext(lines, anchor, options.diffContext);
    }
    return { ...comment, outdated, anchor: { ...anchor, diffContext } };
  });
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
  endAnchor: Record<string, unknown> | null;
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
      endAnchor: asRecord(prop(discussion, 'endAnchor')),
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
  const end = discussion.endAnchor;
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
            line: lineNumber(prop(anchor, 'line')),
            oldLine: lineNumber(prop(anchor, 'oldLine')),
            revision: stringOrNull(prop(anchor, 'revision')),
            end:
              end !== null
                ? {
                    line: lineNumber(prop(end, 'line')),
                    oldLine: lineNumber(prop(end, 'oldLine')),
                    revision: stringOrNull(prop(end, 'revision')),
                  }
                : null,
            snippet: snippetLines.map((line) => ({
              text: stringOrNull(prop(line, 'text')),
              oldLineNum: lineNumber(prop(line, 'oldLineNum')),
              newLineNum: lineNumber(prop(line, 'newLineNum')),
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

/*
 * Pinned live (M3 probe): Space line coordinates are 0-based — anchor.line 71
 * is `text-content` lines[71], verified against snippets and file content on
 * 50+ anchors (both sides). Output is 1-based so agents can use it directly
 * with editors, `sed -n`, and `grep -n`.
 */
function lineNumber(value: unknown): number | null {
  const n = numberOrNull(value);
  return n === null ? null : n + 1;
}

/** Space anchors file paths with a leading `/`; normalize it away. */
export function normalizeFilePath(path: string): string {
  return path.replace(/^\//, '');
}
