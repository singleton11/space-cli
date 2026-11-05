import { readFileSync } from 'node:fs';
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
    if (url.includes('/code-reviews/rev1?')) return { feedChannelId: FEED_CHANNEL };
    if (url.includes('/code-reviews/rev1/unbound-discussions')) {
      return loadFixture('unbound-discussions.json');
    }
    if (url.includes(`/chats/messages`) && url.includes(`channel=${FEED_CHANNEL}`)) {
      return loadFixture('feed-channel-projected.json');
    }
    if (url.includes('/chats/messages')) return loadFixture('thread-messages.json');
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
      anchor: { file: 'language-server/features-impl/db-connectivity/src/commands/mcp.kt', line: 71 },
    });
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
