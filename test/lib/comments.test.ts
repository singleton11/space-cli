import { describe, expect, it } from 'vitest';
import { listComments, normalizeFilePath } from '../../src/lib/comments.js';
import { SpaceCliError } from '../../src/lib/errors.js';
import { filesRoute, fixture, notFound, routingClient, type Route } from '../support.js';

const PROJECT = 'IJ';
const REVIEW = 'rev1';
const FEED_CHANNEL = '4Q1Lo73xJbml';
const MCP_KT = 'language-server/features-impl/db-connectivity/src/commands/mcp.kt';
const MCP_REVISION = 'ef27fe0d70ed8a9518efddac4c6371530fc86469';

/** `text-content` for mcp.kt at the 1mZGCe08o6SN anchor revision (real capture); everything else 404s. */
const textContentRoute: Route = {
  test: (p) => p.endsWith('/text-content'),
  respond: (_p, params) =>
    params.commit === MCP_REVISION && params.path === MCP_KT ? fixture('text-content-at-revision.json') : notFound(),
};

/**
 * The golden routing: real fixtures, exactly as captured live under the
 * pinned projections (review IJ #232805, never rebased — every anchor
 * revision is an in-review commit; head cc72ec46).
 */
function goldenRoutes(): Route[] {
  return [
    {
      test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`,
      body: { feedChannelId: FEED_CHANNEL },
    },
    {
      test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}/details`,
      body: fixture('review-details-commits.json'),
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
    filesRoute(),
    textContentRoute,
  ];
}

describe('listComments — golden pipeline against M2 fixtures', () => {
  it('merges 10 anchored threads and 1 review-level thread (ghost filtered), sorted oldest first', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW);
    expect(comments).toHaveLength(11); // 10 anchored + 1 review-level; the deleted-message ghost is filtered
    expect(comments[0]).toMatchObject({
      id: '4fQkrd3xmHyz',
      kind: 'review-level',
      author: 'Anton.Prokhorov',
      resolved: false, // null in the API means "never toggled" → not resolved
      outdated: null, // review-level comments have no anchor to be outdated
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

  it('maps the pinned discussion 1mZGCe08o6SN field by field, line numbers 1-based', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW);
    const c = comments.find((x) => x.id === '1mZGCe08o6SN')!;
    expect(c).toMatchObject({
      id: '1mZGCe08o6SN',
      reviewId: REVIEW,
      threadChannelId: 'qaVlL1x77TG',
      kind: 'anchored',
      author: 'Alexander.Gusakov',
      createdAt: 1793699891738,
      resolved: true,
      outdated: true, // mcp.kt changed after ef27fe0d (blob 8696d8c1 → 191a209c at head)
      text: expect.stringContaining('Looks like a magic'),
    });
    expect(c.anchor).toMatchObject({
      file: MCP_KT,
      repository: 'ultimate',
      line: 72, // Space: 71, 0-based
      oldLine: null,
      revision: MCP_REVISION,
      end: null,
    });
    expect(c.anchor).not.toHaveProperty('diffContext'); // only with --diff-context
    expect(c.anchor!.snippet).toHaveLength(7);
    expect(c.anchor!.snippet[0]).toEqual({ text: '    }', oldLineNum: 52, newLineNum: 68 });
    expect(c.replies).toEqual([
      {
        id: 'F9e8f0W7qz7',
        author: 'Viacheslav.Ermakov',
        createdAt: 1793731294291,
        text: 'User resolved the discussion',
      },
    ]);
  });

  it('outdated: false only where the file blob is unchanged at the review head', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW);
    const outdated = Object.fromEntries(comments.map((c) => [c.id, c.outdated]));
    expect(outdated).toEqual({
      '4fQkrd3xmHyz': null,
      '1mZGCe08o6SN': true,
      '4QHP1M3fDCmP': true,
      '10NXKA26iIMA': true,
      '1TS2J321By7C': true,
      '4drphw3wamjN': true,
      KeP0I1L5CR4: true,
      T8Ogg09mZHO: false, // LSMcpStarter.kt: blob 479d5433 at a18bbf70 and at head
      '2ByDmx0nphQX': true,
      '347f3A3Z0YHY': true,
      '4YHAM13oDopn': true,
    });
  });

  it('memoizes blob lookups: one files request per distinct (revision, path)', async () => {
    const { calls, client } = routingClient(goldenRoutes());
    await listComments(client, PROJECT, REVIEW);
    const keys = calls.filter((c) => c.path.endsWith('/files')).map((c) => `${c.params.commit}:${c.params.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(16); // 9 distinct (revision, file) anchors + 7 distinct files at head
    expect(calls.filter((c) => c.path.endsWith('/details'))).toHaveLength(1);
  });

  it('resolves the feed channel via the review record and 404s as not-found on a null body', async () => {
    const { client } = routingClient([
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: null },
    ]);
    await expect(listComments(client, PROJECT, REVIEW)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('raises protocol-error when the review record has no feed channel', async () => {
    const { client } = routingClient([
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { id: REVIEW } },
    ]);
    await expect(listComments(client, PROJECT, REVIEW)).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });
});

describe('listComments — diff context', () => {
  it('attaches the file at the anchor revision, N lines around the anchor, 1-based', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW, { file: MCP_KT }, { diffContext: 3 });
    const c = comments.find((x) => x.id === '1mZGCe08o6SN')!;
    const context = c.anchor!.diffContext!;
    expect(context.revision).toBe(MCP_REVISION);
    expect(context.side).toBe('new');
    expect(context.lines.map((l) => l.line)).toEqual([69, 70, 71, 72, 73, 74, 75]); // file has 75 lines
    expect(context.lines[3]).toEqual({ line: 72, text: '    service<LspMcpServerStatusPublisher>()' });
    // The built-in snippet and the fetched content agree on the anchored line.
    const snippetLine = c.anchor!.snippet.find((s) => s.newLineNum === c.anchor!.line);
    expect(snippetLine!.text).toBe(context.lines[3]!.text);
  });

  it('is null when the content is unavailable (file missing at the revision)', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW, { file: MCP_KT }, { diffContext: 3 });
    // The two later mcp.kt threads anchor at a18bbf70, which the text route 404s.
    expect(comments.find((x) => x.id === '4drphw3wamjN')!.anchor!.diffContext).toBeNull();
  });

  it('fetches content once per distinct (revision, file) and only for comments that pass the filters', async () => {
    const { calls, client } = routingClient(goldenRoutes());
    await listComments(client, PROJECT, REVIEW, { file: MCP_KT }, { diffContext: 3 });
    const texts = calls.filter((c) => c.path.endsWith('/text-content'));
    expect(texts.map((c) => c.params.commit)).toEqual([MCP_REVISION, 'a18bbf70a13273e3e493f1cbd7787f618ad6d97c']);
    expect(texts.every((c) => c.params.path === MCP_KT && c.params.$fields === 'type,lines(text)')).toBe(true);
    expect(calls.filter((c) => c.path.endsWith('/files')).every((c) => c.params.path === MCP_KT)).toBe(true);
  });

  it('skips the details request when no anchored comment is left after filtering', async () => {
    const { calls, client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW, { author: 'Anton.Prokhorov' }, { diffContext: 3 });
    expect(comments.map((c) => c.kind)).toEqual(['review-level']);
    expect(calls.some((c) => c.path.endsWith('/details') || c.path.endsWith('/files'))).toBe(false);
  });
});

describe('listComments — commit-set review with range comments (golden, AMPER #3842)', () => {
  const CSR_FEED = '1OUoqu0ZogwK';
  function csrRoutes(): Route[] {
    return [
      { test: (p) => p === '/projects/key%3AAMPER/code-reviews/csr', body: { feedChannelId: CSR_FEED } },
      { test: (p) => p.endsWith('/csr/details'), body: fixture('review-details-csr.json') },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === CSR_FEED,
        body: fixture('feed-csr-range-anchors.json'),
      },
      { test: (p) => p === '/chats/messages', body: fixture('thread-messages.json') },
      { test: (p) => p.endsWith('/unbound-discussions'), body: { totalCount: 0, data: [] } },
      filesRoute(),
      {
        test: (p) => p === '/projects/key%3AAMPER/repositories/amper/text-content',
        respond: (_p, params) =>
          params.commit === '7911192f78f11d24353110ba1f3f074de5f451e5' ? fixture('text-content-lean.json') : notFound(),
      },
    ];
  }

  it('maps endAnchor to anchor.end (1-based) and widens diffContext over the range', async () => {
    const { client } = routingClient(csrRoutes());
    const comments = await listComments(client, 'AMPER', 'csr', {}, { diffContext: 2 });
    const range = comments.find((c) => c.id === '4MNqxQ4fYCFw')!;
    expect(range.anchor).toMatchObject({
      line: 23,
      end: { line: 32, oldLine: null, revision: '7911192f78f11d24353110ba1f3f074de5f451e5' },
    });
    const lines = range.anchor!.diffContext!.lines;
    expect(lines[0]!.line).toBe(21);
    expect(lines.at(-1)!.line).toBe(34);
    const raw = fixture<{ lines: { text: string }[] }>('text-content-lean.json').lines;
    expect(lines.map((l) => l.text)).toEqual(raw.slice(20, 34).map((l) => l.text));
    expect(comments.find((c) => c.id === '49vVBX3rLZ80')!.anchor!.end).toBeNull();
  });

  it('compares against the newest in-review commit; an anchor on it is never outdated', async () => {
    const { calls, client } = routingClient(csrRoutes());
    const comments = await listComments(client, 'AMPER', 'csr');
    const outdated = Object.fromEntries(comments.map((c) => [c.id, c.outdated]));
    expect(outdated).toEqual({
      '49vVBX3rLZ80': true,
      '3tckz02iji6p': true,
      '4MBfmc39vNTH': true,
      upnmQ12gTjt: true,
      '4MNqxQ4fYCFw': true,
      CSBsF1HborG: false, // anchored at head 8cda5c13 itself — no blob lookup needed
    });
    const headLookups = calls.filter((c) => c.path.endsWith('/files') && c.params.commit === '8cda5c13c024f194e7aed2d9a2f14e2670c3214a');
    expect(headLookups.map((c) => c.params.path)).toEqual([
      'sources/libraries/agent-detection/src/org/jetbrains/amper/agentdetection/KnownAgents.kt',
      'sources/libraries/agent-detection/test/org/jetbrains/amper/agentdetection/AgentDetectionTest.kt',
    ]);
  });
});

describe('listComments — filters', () => {
  it('--file matches the exact path (leading slash tolerated on both sides)', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW, { file: MCP_KT });
    // Three pinned discussions anchor to mcp.kt (two later ones at lines 37/47).
    expect(comments.map((c) => c.id)).toEqual(['1mZGCe08o6SN', '4drphw3wamjN', 'KeP0I1L5CR4']);
    const { client: client2 } = routingClient(goldenRoutes());
    const withSlash = await listComments(client2, PROJECT, REVIEW, { file: `/${MCP_KT}` });
    expect(withSlash.map((c) => c.id)).toEqual(['1mZGCe08o6SN', '4drphw3wamjN', 'KeP0I1L5CR4']);
  });
  it('--file excludes review-level comments', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW, { file: 'anything.kt' });
    expect(comments).toEqual([]); // review-level comments have no anchor and never match --file
  });
  it('--author matches the root comment author exactly', async () => {
    const { client } = routingClient(goldenRoutes());
    // All 10 anchored roots come from the shared thread fixture (Gusakov);
    // the review-level root is Anton.Prokhorov.
    const comments = await listComments(client, PROJECT, REVIEW, {
      author: 'Alexander.Gusakov',
    });
    expect(comments).toHaveLength(10);
    const { client: client2 } = routingClient(goldenRoutes());
    const anton = await listComments(client2, PROJECT, REVIEW, {
      author: 'Anton.Prokhorov',
    });
    expect(anton.map((c) => c.kind)).toEqual(['review-level']);
  });
  it('--unresolved keeps unresolved threads only', async () => {
    const { client } = routingClient(goldenRoutes());
    const comments = await listComments(client, PROJECT, REVIEW, { unresolved: true });
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
  /** A review whose details know no repository: every anchor is unprovable → outdated. */
  const noDetails: Route = { test: (p) => p.endsWith('/details'), body: { commits: [] } };

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
      noDetails,
    ];
    const { calls, client } = routingClient(routes);
    const comments = await listComments(client, PROJECT, REVIEW);
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
      noDetails,
    ];
    const { client } = routingClient(routes);
    const comments = await listComments(client, PROJECT, REVIEW);
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
      noDetails,
    ];
    const { client } = routingClient(routes);
    const comments = await listComments(client, PROJECT, REVIEW);
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
        outdated: true,
        anchor: {
          file: 'f.kt',
          repository: 'r',
          line: 2,
          oldLine: null,
          revision: 'rev',
          end: null,
          snippet: [{ text: 'x', oldLineNum: 2, newLineNum: 2 }],
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
    await expect(listComments(client, PROJECT, REVIEW)).rejects.toBeInstanceOf(SpaceCliError);
  });

  it('propagates non-404 errors from file lookups instead of guessing', async () => {
    const routes: Route[] = [
      { test: (p) => p === `/projects/key%3AIJ/code-reviews/${REVIEW}`, body: { feedChannelId: 'feed' } },
      {
        test: (p, params) => p === '/chats/messages' && params.channel === 'feed',
        body: { messages: [eventMessage('d', 't1', false)] },
      },
      threadRoute('t1', []),
      { test: (p) => p.includes('unbound-discussions'), body: { totalCount: 0, data: [] } },
      {
        test: (p) => p.endsWith('/details'),
        body: { commits: [{ repository: { name: 'r' }, commits: [{ commit: { id: 'head', parents: ['rev'], commitDate: 1 } }] }] },
      },
      {
        test: (p) => p.endsWith('/files'),
        respond: () => {
          throw new SpaceCliError('internal-server-error', 'boom', 500);
        },
      },
    ];
    const { client } = routingClient(routes);
    await expect(listComments(client, PROJECT, REVIEW)).rejects.toMatchObject({ code: 'internal-server-error' });
  });
});

describe('normalizeFilePath', () => {
  it('strips exactly one leading slash', () => {
    expect(normalizeFilePath('/a/b.kt')).toBe('a/b.kt');
    expect(normalizeFilePath('a/b.kt')).toBe('a/b.kt');
    expect(normalizeFilePath('//a.kt')).toBe('/a.kt');
  });
});
