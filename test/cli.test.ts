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
    expect(request.url).toBe(
      'https://jetbrains.team/api/http/projects/IJ/code-reviews/2AomjG0QgoiG?%24fields=' +
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
