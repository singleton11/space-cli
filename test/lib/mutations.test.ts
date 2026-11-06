import { describe, expect, it } from 'vitest';
import { findCommentById } from '../../src/lib/comments.js';
import { replyToComment, setCommentResolved } from '../../src/lib/mutations.js';
import { SpaceCliError } from '../../src/lib/errors.js';
import { fixture, routingClient, type Route } from '../support.js';

const PROJECT = 'IJ';
const REVIEW = 'rev1';
const FEED_CHANNEL = '4Q1Lo73xJbml';
const ANCHORED_ID = '1mZGCe08o6SN';
const ANCHORED_CHANNEL = 'qaVlL1x77TG';
const REVIEW_LEVEL_ID = '4fQkrd3xmHyz';
const UNBOUND_PATH = `/projects/key%3AIJ/code-reviews/${REVIEW}/unbound-discussions`;
const TOGGLE_PATH = `${UNBOUND_PATH}/${REVIEW_LEVEL_ID}/toggle`;
const READ_BACK_FIELDS = 'data(id,resolved),totalCount';

interface MutationRouteOptions {
  /** What the post-toggle read-back projection reports for the target. */
  resolvedAfter?: boolean;
  /** Response of `POST /chats/messages/send`; `undefined` means an empty body. */
  sendResponse?: unknown;
  /** Override for the read-back projection body (defaults to `resolvedAfter`). */
  readBackBody?: unknown;
  /** Simulated Space error thrown by the toggle. */
  toggleError?: SpaceCliError;
}

/**
 * The M2 golden read-path routing (fixtures captured live, pinned
 * projections) plus writable routes for the mutation surface.
 */
function mutationRoutes(options: MutationRouteOptions = {}): Route[] {
  const {
    resolvedAfter = true,
    sendResponse,
    readBackBody = { data: [{ id: REVIEW_LEVEL_ID, resolved: resolvedAfter }] },
    toggleError,
  } = options;
  return [
    {
      test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`,
      body: { feedChannelId: FEED_CHANNEL },
    },
    {
      test: (p, params) => p === '/chats/messages' && params.channel === FEED_CHANNEL,
      body: fixture('feed-channel-projected.json'),
    },
    { test: (p) => p === '/chats/messages', body: fixture('thread-messages.json') },
    // Read-back projection used to verify the toggle (pinned in api-notes §Resolve).
    // Must precede the golden route below — same path, different $fields projection.
    {
      test: (p, params) => p === UNBOUND_PATH && params.$fields === READ_BACK_FIELDS,
      body: readBackBody,
    },
    { test: (p) => p === UNBOUND_PATH, body: fixture('unbound-discussions.json') },
    {
      test: (p) => p === '/chats/messages/send',
      ...(sendResponse === undefined ? { respond: () => undefined } : { body: sendResponse }),
    },
    {
      test: (p) => p === TOGGLE_PATH,
      respond: () => {
        if (toggleError) throw toggleError;
        return undefined;
      },
    },
  ];
}

describe('findCommentById — M4 lookup without enrichment', () => {
  it('finds an anchored thread by discussion id, skipping anchor enrichment', async () => {
    const { calls, client } = routingClient(mutationRoutes());
    const comment = await findCommentById(client, PROJECT, REVIEW, ANCHORED_ID);

    expect(comment).toMatchObject({
      id: ANCHORED_ID,
      kind: 'anchored',
      threadChannelId: ANCHORED_CHANNEL,
      outdated: null, // enrichment deliberately skipped in the M4 lookup
    });
    // No enrichment requests: no review details, no repository file lookups.
    expect(calls.some((c) => c.path.endsWith('/details'))).toBe(false);
    expect(calls.some((c) => c.path.includes('/repositories/'))).toBe(false);
  });

  it('finds a review-level thread by discussion id', async () => {
    const { client } = routingClient(mutationRoutes());
    const comment = await findCommentById(client, PROJECT, REVIEW, REVIEW_LEVEL_ID);

    expect(comment).toMatchObject({
      id: REVIEW_LEVEL_ID,
      kind: 'review-level',
      threadChannelId: FEED_CHANNEL, // review-level threads live in the review channel
    });
  });

  it('returns null for an unknown comment id', async () => {
    const { client } = routingClient(mutationRoutes());
    expect(await findCommentById(client, PROJECT, REVIEW, 'nope')).toBeNull();
  });
});

describe('replyToComment', () => {
  it('posts the text verbatim into the anchored thread channel', async () => {
    const sendResponse = {
      id: 'msg-1',
      text: 'done',
      time: 1793800000000,
      author: { name: 'Anton.Prokhorov' },
    };
    const { calls, client } = routingClient(mutationRoutes({ sendResponse }));

    const result = await replyToComment(client, PROJECT, REVIEW, ANCHORED_ID, 'Fixed in abc123.');

    expect(result).toEqual({
      commentId: ANCHORED_ID,
      reviewId: REVIEW,
      threadChannelId: ANCHORED_CHANNEL,
      message: { id: 'msg-1', text: 'done', author: 'Anton.Prokhorov', createdAt: 1793800000000 },
    });
    const send = calls.find((c) => c.method === 'post');
    expect(send?.path).toBe('/chats/messages/send');
    expect(send?.body).toEqual({ channel: ANCHORED_CHANNEL, text: 'Fixed in abc123.' });
  });

  it('replies to a review-level comment via the review channel', async () => {
    const { calls, client } = routingClient(mutationRoutes());
    await replyToComment(client, PROJECT, REVIEW, REVIEW_LEVEL_ID, 'ack');
    expect(calls.find((c) => c.method === 'post')?.body).toEqual({
      channel: FEED_CHANNEL,
      text: 'ack',
    });
  });

  it('accepts Space identifier-wrapper message ids in the send response', async () => {
    const { client } = routingClient(
      mutationRoutes({ sendResponse: { id: { className: 'ChatMessageIdentifier.InternalId', id: 'wrapped-1' } } }),
    );
    const result = await replyToComment(client, PROJECT, REVIEW, ANCHORED_ID, 'hi');
    expect(result.message).toEqual({ id: 'wrapped-1', text: null, author: null, createdAt: null });
  });

  it('tolerates an empty send response — the mutation already succeeded', async () => {
    const { client } = routingClient(mutationRoutes({ sendResponse: null }));
    const result = await replyToComment(client, PROJECT, REVIEW, ANCHORED_ID, 'hi');
    expect(result.message).toEqual({ id: null, text: null, author: null, createdAt: null });
    expect(result.threadChannelId).toBe(ANCHORED_CHANNEL);
  });

  it('fails with not-found for an unknown comment id', async () => {
    const { calls, client } = routingClient(mutationRoutes());
    await expect(replyToComment(client, PROJECT, REVIEW, 'nope', 'hi')).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(calls.some((c) => c.method === 'post')).toBe(false); // nothing was posted
  });
});

describe('setCommentResolved', () => {
  it('resolves a review-level thread and verifies the state by reading it back', async () => {
    const { calls, client } = routingClient(mutationRoutes({ resolvedAfter: true }));

    const result = await setCommentResolved(client, PROJECT, REVIEW, REVIEW_LEVEL_ID, true);

    expect(result).toEqual({ commentId: REVIEW_LEVEL_ID, reviewId: REVIEW, resolved: true });
    const patch = calls.find((c) => c.method === 'patch');
    expect(patch?.path).toBe(TOGGLE_PATH);
    expect(patch?.body).toEqual({ resolved: true });
    // Read-back happened after the PATCH, via the lean projection.
    const readBack = calls.find(
      (c) => c.method === 'get' && c.path === UNBOUND_PATH && c.params.$fields === READ_BACK_FIELDS,
    );
    expect(calls.indexOf(readBack!)).toBeGreaterThan(calls.indexOf(patch!));
  });

  it('unresolves a review-level thread', async () => {
    const { calls, client } = routingClient(mutationRoutes({ resolvedAfter: false }));
    const result = await setCommentResolved(client, PROJECT, REVIEW, REVIEW_LEVEL_ID, false);
    expect(result.resolved).toBe(false);
    expect(calls.find((c) => c.method === 'patch')?.body).toEqual({ resolved: false });
  });

  it('rejects resolving an anchored thread with the documented platform limitation', async () => {
    const { calls, client } = routingClient(mutationRoutes());
    await expect(setCommentResolved(client, PROJECT, REVIEW, ANCHORED_ID, true)).rejects.toMatchObject({
      code: 'platform-limitation',
    });
    expect(calls.some((c) => c.method === 'patch')).toBe(false); // nothing was toggled
  });

  it('raises protocol-error when the read-back state contradicts the toggle', async () => {
    const { client } = routingClient(mutationRoutes({ resolvedAfter: false })); // PATCHed true, reads false
    await expect(setCommentResolved(client, PROJECT, REVIEW, REVIEW_LEVEL_ID, true)).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });

  it('raises protocol-error when the discussion record vanished after the toggle', async () => {
    const { client } = routingClient(mutationRoutes({ readBackBody: { data: [] } }));
    await expect(setCommentResolved(client, PROJECT, REVIEW, REVIEW_LEVEL_ID, true)).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });

  it('passes Space API errors from the toggle through verbatim', async () => {
    const { client } = routingClient(
      mutationRoutes({ toggleError: new SpaceCliError('internal-server-error', 'Cannot toggle a bound discussion', 500) }),
    );
    await expect(setCommentResolved(client, PROJECT, REVIEW, REVIEW_LEVEL_ID, true)).rejects.toMatchObject({
      code: 'internal-server-error',
      status: 500,
    });
  });

  it('fails with not-found for an unknown comment id', async () => {
    const { client } = routingClient(mutationRoutes());
    await expect(setCommentResolved(client, PROJECT, REVIEW, 'nope', true)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
