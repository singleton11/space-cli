import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';

const NO_HOME = '/nonexistent-home';
const ENV = { SPACE_URL: 'https://jetbrains.team', SPACE_TOKEN: 'test-token' };

const REVIEW_FIXTURE = {
  className: 'MergeRequestRecord',
  id: '2AomjG0QgoiG',
  number: 233811,
  title: 'LS: register MCP tools',
  state: 'Opened',
  createdAt: 1793699891738,
  feedChannelId: 'abc',
  branchPair: {
    repository: 'ultimate',
    sourceBranch: 'feature/mcp',
    targetBranch: 'master',
  },
  participants: [{ user: { id: '1kkPrV2CjbGH' }, role: 'Author' }],
  reviewers: [],
  discussionCounter: {
    resolved: 1,
    unresolved: 0,
    unresolvedSuggestedEdits: 0,
    acceptedSuggestedEdits: 0,
    rejectedSuggestedEdits: 0,
  },
  commits: [{ repositoryId: 'r', commitId: 'c' }],
};

interface Io {
  out: string[];
  err: string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function makeIo(): Io {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

function stubFetch(status: number, body: unknown): typeof fetch {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return vi.fn(async () => new Response(text, { status })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run — reviews show', () => {
  it('emits normalized review JSON to stdout, exit 0', async () => {
    const fetchMock = stubFetch(200, REVIEW_FIXTURE);
    vi.stubGlobal('fetch', fetchMock);

    const io = makeIo();
    const code = await run(['reviews', 'show', '2AomjG0QgoiG', '--project', 'IJ'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed).toMatchObject({ id: '2AomjG0QgoiG', kind: 'mergeRequest', number: 233811 });
    expect(io.out.join('').endsWith('\n')).toBe(true);

    const request = (fetchMock as unknown as { mock: { calls: Request[][] } }).mock.calls[0]![0]!;
    // Bare project keys are auto-prefixed with `key:` — pinned live: bare keys
    // 404 with "Active project with ID IJ not found" on jetbrains.team.
    expect(request.url).toBe(
      'https://jetbrains.team/api/http/projects/key%3AIJ/code-reviews/2AomjG0QgoiG?%24fields=' +
        encodeURIComponent(
          'id,number,title,state,createdAt,feedChannelId,branchPair,participants,reviewers,discussionCounter,commits',
        ),
    );
  });

  it('--pretty indents the output', async () => {
    vi.stubGlobal('fetch', stubFetch(200, REVIEW_FIXTURE));
    const io = makeIo();
    const code = await run(['--pretty', 'reviews', 'show', 'x', '--project', 'IJ'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('\n  "id"');
  });

  it('passes Space error envelopes through on stderr, exit 1', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(404, { error: 'not-found', error_description: 'Review not found' }),
    );
    const io = makeIo();
    const code = await run(['reviews', 'show', 'nope', '--project', 'IJ'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });

    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    const envelope = JSON.parse(io.err.join(''));
    expect(envelope).toEqual({
      error: 'not-found',
      error_description: 'Review not found',
      status: 404,
    });
  });

  it('reports missing config as a JSON envelope, exit 1', async () => {
    const io = makeIo();
    const code = await run(['reviews', 'show', 'x', '--project', 'IJ'], {
      env: {},
      home: NO_HOME,
      ...io,
    });

    expect(code).toBe(1);
    const envelope = JSON.parse(io.err.join(''));
    expect(envelope.error).toBe('config-error');
    expect(envelope.error_description).toContain('SPACE_URL');
  });

  it('usage errors are JSON on stderr, exit 1', async () => {
    const io = makeIo();
    const code = await run(['reviews', 'show', 'x'], { env: ENV, home: NO_HOME, ...io });
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });

  it('unknown options are usage errors too', async () => {
    const io = makeIo();
    const code = await run(['reviews', 'show', 'x', '--project', 'IJ', '--bogus'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });

  it('--help writes help to stdout, exit 0', async () => {
    const io = makeIo();
    const code = await run(['--help'], { env: ENV, home: NO_HOME, ...io });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('reviews');
    expect(io.out.join('')).toContain('--pretty');
  });

  it('no arguments prints usage help, exit 0 via help', async () => {
    const io = makeIo();
    const code = await run([], { env: ENV, home: NO_HOME, ...io });
    // commander with no command and no error: shows help, exit code 1 by default.
    expect(code).toBe(1);
  });
});

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

/** A fetch stub that routes by URL and returns a fresh Response per call. */
function stubFetchRouter(route: (url: string) => unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = route(url);
    if (body === undefined) throw new Error(`no fetch route for ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('run — reviews list', () => {
  it('emits {totalCount, reviews} with filters mapped to query params', async () => {
    const listBody = loadFixture('reviews-list.json');
    let call = 0;
    const fetchMock = stubFetchRouter(() => {
      call += 1;
      return call === 1 ? listBody : { totalCount: (listBody as { totalCount: number }).totalCount, data: [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    const io = makeIo();
    const code = await run(
      ['reviews', 'list', '--project', 'IJ', '--state', 'Opened', '--text', 'mcp', '--limit', '10'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.totalCount).toBe(2513);
    expect(parsed.reviews).toHaveLength(5); // fixture page; second page empty
    expect(parsed.reviews[0]).toMatchObject({ kind: 'mergeRequest' });
    const url = new URL((fetchMock as unknown as { mock: { calls: Request[][] } }).mock.calls[0]![0]!.url);
    expect(url.pathname).toBe('/api/http/projects/key%3AIJ/code-reviews');
    expect(url.searchParams.get('state')).toBe('Opened');
    expect(url.searchParams.get('text')).toBe('mcp');
    expect(url.searchParams.get('$top')).toBe('10');
    expect(url.searchParams.get('$skip')).toBe('0');
  });
  it('rejects an invalid --state as usage-error without any request', async () => {
    const io = makeIo();
    const code = await run(['reviews', 'list', '--project', 'IJ', '--state', 'Open'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });
  it('rejects a non-integer --limit as usage-error', async () => {
    const io = makeIo();
    const code = await run(['reviews', 'list', '--project', 'IJ', '--limit', 'abc'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });
});

describe('run — comments list', () => {
  const FEED_CHANNEL = '4Q1Lo73xJbml';
  function commentsRoute(url: string): unknown {
    const parsed = new URL(url);
    if (url.includes('/code-reviews/rev1?')) return { feedChannelId: FEED_CHANNEL };
    if (url.includes('/code-reviews/rev1/details')) return loadFixture('review-details-commits.json');
    if (url.includes('/code-reviews/rev1/unbound-discussions')) {
      return loadFixture('unbound-discussions.json');
    }
    if (url.includes(`/chats/messages`) && url.includes(`channel=${FEED_CHANNEL}`)) {
      return loadFixture('feed-channel-projected.json');
    }
    if (url.includes('/chats/messages')) return loadFixture('thread-messages.json');
    if (parsed.pathname.endsWith('/repositories/ultimate/files')) {
      const bundle = loadFixture('files-blobs.json') as Record<string, unknown>;
      return bundle[`${parsed.searchParams.get('commit')}:${parsed.searchParams.get('path')}`] ?? [];
    }
    if (parsed.pathname.endsWith('/repositories/ultimate/text-content')) {
      return loadFixture('text-content-at-revision.json');
    }
    return undefined;
  }
  it('emits {reviewId, comments} with anchored + review-level threads', async () => {
    vi.stubGlobal('fetch', stubFetchRouter(commentsRoute));
    const io = makeIo();
    const code = await run(['comments', 'list', '--review', 'rev1', '--project', 'IJ'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.reviewId).toBe('rev1');
    expect(parsed.comments).toHaveLength(11); // 10 anchored + 1 review-level (ghost filtered)
    const mcp = parsed.comments.find((c: { id: string }) => c.id === '1mZGCe08o6SN');
    expect(mcp).toMatchObject({
      kind: 'anchored',
      author: 'Alexander.Gusakov',
      resolved: true,
      outdated: true,
      anchor: { file: 'language-server/features-impl/db-connectivity/src/commands/mcp.kt', line: 72 },
    });
    expect(mcp.anchor).not.toHaveProperty('diffContext');
  });
  it('--diff-context N attaches anchor.diffContext', async () => {
    vi.stubGlobal('fetch', stubFetchRouter(commentsRoute));
    const io = makeIo();
    const code = await run(
      ['comments', 'list', '--review', 'rev1', '--project', 'IJ', '--diff-context', '1',
        '--file', 'language-server/features-impl/db-connectivity/src/commands/mcp.kt'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(0);
    const mcp = JSON.parse(io.out.join('')).comments[0];
    expect(mcp.id).toBe('1mZGCe08o6SN');
    expect(mcp.anchor.diffContext).toEqual({
      revision: 'ef27fe0d70ed8a9518efddac4c6371530fc86469',
      side: 'new',
      lines: [
        { line: 71, text: 'private fun Project.mcpStarter(): LSMcpStarter {' },
        { line: 72, text: '    service<LspMcpServerStatusPublisher>()' },
        { line: 73, text: '    return service<LSMcpStarter>()' },
      ],
    });
  });
  it.each([['-1'], ['abc'], ['1.5']])('--diff-context %s is a usage error', async (value) => {
    const io = makeIo();
    const code = await run(
      ['comments', 'list', '--review', 'rev1', '--project', 'IJ', '--diff-context', value],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });
  it('--unresolved keeps only unresolved threads', async () => {
    vi.stubGlobal('fetch', stubFetchRouter(commentsRoute));
    const io = makeIo();
    const code = await run(
      ['comments', 'list', '--review', 'rev1', '--project', 'IJ', '--unresolved'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.comments).toHaveLength(7);
  });
  it('a missing review (null body) is a not-found envelope, exit 1', async () => {
    vi.stubGlobal('fetch', stubFetchRouter(() => null));
    const io = makeIo();
    const code = await run(['comments', 'list', '--review', 'nope', '--project', 'IJ'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(JSON.parse(io.err.join('')).error).toBe('not-found');
  });
  it('--review is required', async () => {
    const io = makeIo();
    const code = await run(['comments', 'list', '--project', 'IJ'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });
});

/** A fetch stub that routes by URL *and* method and records request bodies. */
function stubMutationFetch(
  route: (url: URL, method: string, requestBody: unknown) => unknown,
): { fetch: typeof fetch; requests: Array<{ method: string; url: string; body: unknown }> } {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    const raw = await request.text();
    const body = route(url, request.method, raw === '' ? undefined : JSON.parse(raw));
    requests.push({ method: request.method, url: url.href, body: raw === '' ? undefined : JSON.parse(raw) });
    if (body === undefined) throw new Error(`no fetch route for ${request.method} ${url.href}`);
    return new Response(body === '' ? '' : JSON.stringify(body), { status: 200 });
  });
  return { fetch: fetchMock as unknown as typeof fetch, requests };
}

describe('run — comments reply/resolve/unresolve (M4)', () => {
  const FEED_CHANNEL = '4Q1Lo73xJbml';
  const ANCHORED_ID = '1mZGCe08o6SN';
  const ANCHORED_CHANNEL = 'qaVlL1x77TG';
  const REVIEW_LEVEL_ID = '4fQkrd3xmHyz';

  /** Golden discovery routing + writable mutation endpoints; `resolvedAfter` drives the read-back. */
  function mutationsRoute(resolvedAfter: boolean) {
    return (url: URL, method: string): unknown => {
      const review = '/api/http/projects/key%3AIJ/code-reviews/rev1';
      if (method === 'GET' && url.pathname === review) return { feedChannelId: FEED_CHANNEL };
      if (method === 'GET' && url.pathname === '/api/http/chats/messages') {
        return url.searchParams.get('channel') === FEED_CHANNEL
          ? loadFixture('feed-channel-projected.json')
          : loadFixture('thread-messages.json');
      }
      if (method === 'GET' && url.pathname === `${review}/unbound-discussions`) {
        return url.searchParams.get('$fields') === 'data(id,resolved),totalCount'
          ? { data: [{ id: REVIEW_LEVEL_ID, resolved: resolvedAfter }] }
          : loadFixture('unbound-discussions.json');
      }
      if (method === 'POST' && url.pathname === '/api/http/chats/messages/send') {
        return { id: 'msg-1', text: 'done', time: 1793800000000, author: { name: 'Anton.Prokhorov' } };
      }
      if (method === 'PATCH' && url.pathname === `${review}/unbound-discussions/${REVIEW_LEVEL_ID}/toggle`) {
        return ''; // pinned live: 200 with an empty body
      }
      return undefined;
    };
  }

  it('reply --text posts into the thread channel and emits the result', async () => {
    const { fetch, requests } = stubMutationFetch(mutationsRoute(true));
    vi.stubGlobal('fetch', fetch);
    const io = makeIo();
    const code = await run(
      ['comments', 'reply', '--comment', ANCHORED_ID, '--review', 'rev1', '--project', 'IJ', '--text', 'Fixed in abc123.'],
      { env: ENV, home: NO_HOME, ...io },
    );

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(JSON.parse(io.out.join(''))).toEqual({
      commentId: ANCHORED_ID,
      reviewId: 'rev1',
      threadChannelId: ANCHORED_CHANNEL,
      message: { id: 'msg-1', text: 'done', author: 'Anton.Prokhorov', createdAt: 1793800000000 },
    });
    const send = requests.find((r) => r.method === 'POST');
    expect(send?.body).toEqual({ channel: ANCHORED_CHANNEL, text: 'Fixed in abc123.' });
  });

  it('reply --stdin reads stdin and strips one trailing newline', async () => {
    const { fetch, requests } = stubMutationFetch(mutationsRoute(true));
    vi.stubGlobal('fetch', fetch);
    const io = makeIo();
    const code = await run(
      ['comments', 'reply', '--comment', ANCHORED_ID, '--review', 'rev1', '--project', 'IJ', '--stdin'],
      { env: ENV, home: NO_HOME, ...io, stdin: async () => 'piped reply\n' },
    );

    expect(code).toBe(0);
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      channel: ANCHORED_CHANNEL,
      text: 'piped reply',
    });
  });

  it('reply: --text and --stdin are mutually exclusive', async () => {
    const io = makeIo();
    const code = await run(
      ['comments', 'reply', '--comment', 'x', '--review', 'rev1', '--project', 'IJ', '--text', 'a', '--stdin'],
      { env: ENV, home: NO_HOME, ...io, stdin: async () => 'b' },
    );
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });

  it('reply: exactly one of --text/--stdin is required', async () => {
    const io = makeIo();
    const code = await run(
      ['comments', 'reply', '--comment', 'x', '--review', 'rev1', '--project', 'IJ'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });

  it('reply: empty text is a usage error', async () => {
    const io = makeIo();
    const code = await run(
      ['comments', 'reply', '--comment', 'x', '--review', 'rev1', '--project', 'IJ', '--text', '  '],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join('')).error).toBe('usage-error');
  });

  it('reply to an unknown comment id is a not-found envelope', async () => {
    const { fetch } = stubMutationFetch(mutationsRoute(true));
    vi.stubGlobal('fetch', fetch);
    const io = makeIo();
    const code = await run(
      ['comments', 'reply', '--comment', 'nope', '--review', 'rev1', '--project', 'IJ', '--text', 'hi'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(JSON.parse(io.err.join('')).error).toBe('not-found');
  });

  it('resolve marks a review-level thread resolved, verifying the state by read-back', async () => {
    const { fetch, requests } = stubMutationFetch(mutationsRoute(true));
    vi.stubGlobal('fetch', fetch);
    const io = makeIo();
    const code = await run(
      ['comments', 'resolve', '--comment', REVIEW_LEVEL_ID, '--review', 'rev1', '--project', 'IJ'],
      { env: ENV, home: NO_HOME, ...io },
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.out.join(''))).toEqual({
      commentId: REVIEW_LEVEL_ID,
      reviewId: 'rev1',
      resolved: true,
    });
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.url).toContain(`/unbound-discussions/${REVIEW_LEVEL_ID}/toggle`);
    expect(patch?.body).toEqual({ resolved: true });
    // The state was read back after the PATCH, via the lean projection.
    const readBack = requests.find(
      (r) =>
        r.method === 'GET' &&
        r.url.includes('/unbound-discussions') &&
        new URL(r.url).searchParams.get('$fields') === 'data(id,resolved),totalCount',
    );
    expect(requests.indexOf(readBack!)).toBeGreaterThan(requests.indexOf(patch!));
  });

  it('unresolve reopens a review-level thread', async () => {
    const { fetch, requests } = stubMutationFetch(mutationsRoute(false));
    vi.stubGlobal('fetch', fetch);
    const io = makeIo();
    const code = await run(
      ['comments', 'unresolve', '--comment', REVIEW_LEVEL_ID, '--review', 'rev1', '--project', 'IJ'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join(''))).toMatchObject({ resolved: false });
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ resolved: false });
  });

  it('resolve on an anchored thread fails with the documented platform-limitation envelope', async () => {
    const { fetch, requests } = stubMutationFetch(mutationsRoute(true));
    vi.stubGlobal('fetch', fetch);
    const io = makeIo();
    const code = await run(
      ['comments', 'resolve', '--comment', ANCHORED_ID, '--review', 'rev1', '--project', 'IJ'],
      { env: ENV, home: NO_HOME, ...io },
    );
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(JSON.parse(io.err.join(''))).toMatchObject({ error: 'platform-limitation' });
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false); // nothing was toggled
  });
});

describe('run — skill install', () => {
  const TMP_ROOT = mkdtempSync(join(tmpdir(), 'space-cli-skill-'));

  it('installs the bundled skill into a --dir, exit 0, and reports the path', async () => {
    const io = makeIo();
    const code = await run(['skill', 'install', '--dir', TMP_ROOT], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.overwritten).toBe(false);
    const installed = readFileSync(parsed.installed, 'utf8');
    const source = readFileSync(new URL('../skills/space-cli/SKILL.md', import.meta.url), 'utf8');
    expect(installed).toBe(source);
  });

  it('refuses to overwrite an existing install without --force (usage-error)', async () => {
    const io = makeIo();
    const code = await run(['skill', 'install', '--dir', TMP_ROOT], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(JSON.parse(io.err.join(''))).toMatchObject({ error: 'usage-error' });
  });

  it('overwrites with --force and reports overwritten: true', async () => {
    const io = makeIo();
    const code = await run(['skill', 'install', '--dir', TMP_ROOT, '--force'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('')).overwritten).toBe(true);
  });

  it('derives the --agent pi directory from home', async () => {
    const io = makeIo();
    const code = await run(['skill', 'install', '--agent', 'pi'], {
      env: ENV,
      home: TMP_ROOT,
      ...io,
    });
    expect(code).toBe(0);
    const { installed } = JSON.parse(io.out.join(''));
    expect(installed).toBe(join(TMP_ROOT, '.pi', 'agent', 'skills', 'space-cli', 'SKILL.md'));
  });

  it('rejects an unknown agent with a usage-error', async () => {
    const io = makeIo();
    const code = await run(['skill', 'install', '--agent', 'vscode'], {
      env: ENV,
      home: NO_HOME,
      ...io,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.err.join(''))).toMatchObject({ error: 'usage-error' });
  });
});
