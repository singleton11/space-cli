import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listComments, normalizeFilePath } from '../../src/lib/comments.js';
import { SpaceCliError } from '../../src/lib/errors.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '../../fixtures', name), 'utf8'),
  ) as Record<string, unknown>;
}

type Params = Record<string, string | number | boolean | undefined | null>;
interface Call {
  path: string;
  params: Params;
}
type Route = { test: (path: string, params: Params) => boolean; body: unknown };

/** A SpaceClient double that records every GET and routes by path/params. */
function routingClient(routes: Route[]): { calls: Call[]; client: unknown } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async get<T>(path: string, params?: Params): Promise<T> {
        calls.push({ path, params: { ...(params ?? {}) } });
        for (const route of routes) {
          if (route.test(path, params ?? {})) return route.body as T;
        }
        throw new Error(`no route for GET ${path}`);
      },
    },
  };
}

const PROJECT = 'IJ';
const REVIEW = 'rev1';
const FEED_CHANNEL = '4Q1Lo73xJbml';

/** The golden routing: real fixtures, exactly as captured live under the pinned projections. */
function goldenRoutes(): Route[] {
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
    {
      test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}/unbound-discussions`,
      body: fixture('unbound-discussions.json'),
    },
  ];
}

describe('listComments — golden pipeline against M2 fixtures', () => {
  it('merges 10 anchored threads and 1 review-level thread (ghost filtered), sorted oldest first', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client as never, PROJECT, REVIEW);
    expect(comments).toHaveLength(11); // 10 anchored + 1 review-level; the deleted-message ghost is filtered
    expect(comments[0]).toMatchObject({
      id: '4fQkrd3xmHyz',
      kind: 'review-level',
      author: 'Anton.Prokhorov',
      resolved: false, // null in the API means "never toggled" → not resolved
      anchor: null,
      threadChannelId: FEED_CHANNEL,
      replies: [],
    });
    const anchored = comments.filter((c) => c.kind === 'anchored');
    expect(anchored).toHaveLength(10);
    // Space's leading "/" on filenames is normalized away everywhere.
    for (const c of anchored) {
      expect(c.anchor!.file.startsWith('/')).toBe(false);
    }
  });

  it('maps the pinned discussion 1mZGCe08o6SN field by field', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client as never, PROJECT, REVIEW);
    const c = comments.find((x) => x.id === '1mZGCe08o6SN')!;
    expect(c).toMatchObject({
      id: '1mZGCe08o6SN',
      reviewId: REVIEW,
      threadChannelId: 'qaVlL1x77TG',
      kind: 'anchored',
      author: 'Alexander.Gusakov',
      createdAt: 1793699891738,
      resolved: true,
      outdated: null, // computed from M3 on
      text: expect.stringContaining('Looks like a magic'),
    });
    expect(c.anchor).toMatchObject({
      file: 'language-server/features-impl/db-connectivity/src/commands/mcp.kt',
      repository: 'ultimate',
      line: 71,
      oldLine: null,
      revision: 'ef27fe0d70ed8a9518efddac4c6371530fc86469',
    });
    expect(c.anchor!.snippet).toHaveLength(7);
    expect(c.anchor!.snippet[0]).toEqual({ text: '    }', oldLineNum: 51, newLineNum: 67 });
    expect(c.replies).toEqual([
      {
        id: 'F9e8f0W7qz7',
        author: 'Viacheslav.Ermakov',
        createdAt: 1793731294291,
        text: 'User resolved the discussion',
      },
    ]);
  });

  it('resolves the feed channel via the review record and 404s as not-found on a null body', async () => {
    const { client } = routingClient([
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: null },
    ]);
    await expect(listComments(client as never, PROJECT, REVIEW)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('raises protocol-error when the review record has no feed channel', async () => {
    const { client } = routingClient([
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { id: REVIEW } },
    ]);
    await expect(listComments(client as never, PROJECT, REVIEW)).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });
});

describe('listComments — filters', () => {
  it('--file matches the exact path (leading slash tolerated on both sides)', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client as never, PROJECT, REVIEW, {
      file: 'language-server/features-impl/db-connectivity/src/commands/mcp.kt',
    });
    // Three pinned discussions anchor to mcp.kt (two later ones at lines 37/47).
    expect(comments.map((c) => c.id)).toEqual(['1mZGCe08o6SN', '4drphw3wamjN', 'KeP0I1L5CR4']);
    const { client: client2 } = routingClient(goldenRoutes());
    const withSlash = await listComments(client2 as never, PROJECT, REVIEW, {
      file: '/language-server/features-impl/db-connectivity/src/commands/mcp.kt',
    });
    expect(withSlash.map((c) => c.id)).toEqual(['1mZGCe08o6SN', '4drphw3wamjN', 'KeP0I1L5CR4']);
  });
  it('--file excludes review-level comments', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client as never, PROJECT, REVIEW, { file: 'anything.kt' });
    expect(comments).toEqual([]); // review-level comments have no anchor and never match --file
  });
  it('--author matches the root comment author exactly', async () => {
    const { client } = routingClient(goldenRoutes());
    // All 10 anchored roots come from the shared thread fixture (Gusakov);
    // the review-level root is Anton.Prokhorov.
    const comments = await listComments(client as never, PROJECT, REVIEW, {
      author: 'Alexander.Gusakov',
    });
    expect(comments).toHaveLength(10);
    const { client: client2 } = routingClient(goldenRoutes());
    const anton = await listComments(client2 as never, PROJECT, REVIEW, {
      author: 'Anton.Prokhorov',
    });
    expect(anton.map((c) => c.kind)).toEqual(['review-level']);
  });
  it('--unresolved keeps unresolved threads only', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client as never, PROJECT, REVIEW, { unresolved: true });
    // 6 unresolved anchored threads + the review-level one (resolved: null → false).
    expect(comments).toHaveLength(7);
    expect(comments.every((c) => !c.resolved)).toBe(true);
  });
});

describe('listComments — feed pagination and robustness', () => {
  function eventMessage(discussionId: string, channelId: string, resolved: boolean) {
    return {
      id: `msg-${discussionId}`,
      details: {
        className: 'CodeDiscussionAddedFeedEvent',
        codeDiscussion: {
          id: discussionId,
          anchor: { repository: 'r', revision: 'rev', filename: '/f.kt', line: 1, oldLine: null },
          channel: { id: channelId },
          resolvable: true,
          resolved,
          snippet: { lines: [{ text: 'x', oldLineNum: 1, newLineNum: 1 }] },
        },
      },
    };
  }
  function threadRoute(channel: string, messages: unknown[]): Route {
    return {
      test: (p, params) => p === '/chats/messages' && params.channel === channel,
      body: { messages },
    };
  }

  it('follows nextStartFromDate → startFromDate while batches come back full', async () => {
    const full = Array.from({ length: 50 }, (_, i) =>
      i === 49 ? eventMessage('d1', 't1', false) : { id: `m${i}`, details: { className: 'MCMessage' } },
    );
    const routes: Route[] = [
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { feedChannelId: 'feed' } },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === 'feed' && params.startFromDate === undefined,
        body: { messages: full, nextStartFromDate: { iso: '2026-11-05T00:00:00.000Z' } },
      },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === 'feed' && params.startFromDate === '2026-11-05T00:00:00.000Z',
        body: { messages: [eventMessage('d2', 't2', true)], nextStartFromDate: { iso: '2026-11-06T00:00:00.000Z' } },
      },
      threadRoute('t1', [{ id: 'r1', time: 1, text: 'root one', author: { name: 'A' } }]),
      threadRoute('t2', [{ id: 'r2', time: 2, text: 'root two', author: { name: 'B' } }]),
      { test: (p) => p.includes('unbound-discussions'), body: { totalCount: 0, data: [] } },
    ];
    const { calls, client } = routingClient(routes);
    const comments = await listComments(client as never, PROJECT, REVIEW);
    expect(comments.map((c) => c.id)).toEqual(['d1', 'd2']);
    const feedCalls = calls.filter(
      (c) => c.path === '/chats/messages' && c.params.channel === 'feed',
    );
    expect(feedCalls).toHaveLength(2);
    expect(feedCalls[1]!.params.startFromDate).toBe('2026-11-05T00:00:00.000Z');
  });

  it('dedupes repeated discussion events by id, keeping the latest state', async () => {
    const routes: Route[] = [
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { feedChannelId: 'feed' } },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === 'feed',
        body: {
          messages: [
            eventMessage('dup', 't1', false),
            { id: 'noise', details: { className: 'CodeDiscussionAddedFeedEvent', codeDiscussion: null } },
            eventMessage('dup', 't1', true),
          ],
        },
      },
      threadRoute('t1', [{ id: 'r1', time: 1, text: 'root', author: { name: 'A' } }]),
      { test: (p) => p.includes('unbound-discussions'), body: { totalCount: 0, data: [] } },
    ];
    const { client } = routingClient(routes);
    const comments = await listComments(client as never, PROJECT, REVIEW);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.resolved).toBe(true);
  });

  it('tolerates a discussion thread with no messages (author/text null, no replies)', async () => {
    const routes: Route[] = [
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { feedChannelId: 'feed' } },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === 'feed',
        body: { messages: [eventMessage('empty', 't1', false)] },
      },
      threadRoute('t1', []),
      { test: (p) => p.includes('unbound-discussions'), body: { totalCount: 0, data: [] } },
    ];
    const { client } = routingClient(routes);
    const comments = await listComments(client as never, PROJECT, REVIEW);
    expect(comments).toEqual([
      {
        id: 'empty',
        reviewId: REVIEW,
        threadChannelId: 't1',
        kind: 'anchored',
        author: null,
        createdAt: null,
        text: null,
        resolved: false,
        outdated: null,
        anchor: {
          file: 'f.kt',
          repository: 'r',
          line: 1,
          oldLine: null,
          revision: 'rev',
          snippet: [{ text: 'x', oldLineNum: 1, newLineNum: 1 }],
        },
        replies: [],
      },
    ]);
  });

  it('raises protocol-error when a discussion has no thread channel', async () => {
    const routes: Route[] = [
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { feedChannelId: 'feed' } },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === 'feed',
        body: {
          messages: [
            {
              id: 'm',
              details: {
                className: 'CodeDiscussionAddedFeedEvent',
                codeDiscussion: { id: 'orphan', anchor: null, channel: {}, resolved: false, snippet: null },
              },
            },
          ],
        },
      },
      { test: (p) => p.includes('unbound-discussions'), body: { totalCount: 0, data: [] } },
    ];
    const { client } = routingClient(routes);
    await expect(listComments(client as never, PROJECT, REVIEW)).rejects.toBeInstanceOf(SpaceCliError);
  });
});

describe('normalizeFilePath', () => {
  it('strips exactly one leading slash', () => {
    expect(normalizeFilePath('/a/b.kt')).toBe('a/b.kt');
    expect(normalizeFilePath('a/b.kt')).toBe('a/b.kt');
    expect(normalizeFilePath('//a.kt')).toBe('/a.kt');
  });
});
