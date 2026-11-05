import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpaceCliError } from '../../src/lib/errors.js';
import { SpaceClient } from '../../src/lib/http.js';

const BASE = 'https://jetbrains.team';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SpaceClient.get', () => {
  it('sends the bearer token and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'abc', number: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpaceClient(BASE, 'tok');
    const result = await client.get<{ id: string; number: number }>(
      '/projects/IJ/code-reviews/abc',
    );

    expect(result).toEqual({ id: 'abc', number: 42 });
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe('https://jetbrains.team/api/http/projects/IJ/code-reviews/abc');
    expect(request.headers.get('authorization')).toBe('Bearer tok');
  });

  it('encodes path segments and appends query params', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpaceClient(BASE, 'tok');
    await client.get('/projects/key:IJ/code-reviews/a b', {
      $skip: 10,
      $top: 20,
      state: 'Opened',
      text: undefined,
    });

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    // `:` is legal in a path segment — WHATWG normalization keeps it as-is.
    expect(url.pathname).toBe('/api/http/projects/key:IJ/code-reviews/a%20b');
    expect(decodeURIComponent(url.pathname)).toBe('/api/http/projects/key:IJ/code-reviews/a b');
    expect(url.searchParams.get('$skip')).toBe('10');
    expect(url.searchParams.get('$top')).toBe('20');
    expect(url.searchParams.get('state')).toBe('Opened');
    expect(url.searchParams.has('text')).toBe(false);
  });

  it('strips trailing slashes from the base url', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SpaceClient('https://jetbrains.team/', 'tok');
    await client.get('/projects');

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe('https://jetbrains.team/api/http/projects');
  });

  it('passes Space error envelopes through verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          await jsonResponse(404, { error: 'not-found', error_description: 'Review not found' }),
      ),
    );

    const client = new SpaceClient(BASE, 'tok');
    const promise = client.get('/projects/IJ/code-reviews/nope');
    await expect(promise).rejects.toMatchObject({
      code: 'not-found',
      description: 'Review not found',
      status: 404,
    });
  });

  it('wraps non-JSON error bodies as http-error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(502, 'Bad gateway')));

    const client = new SpaceClient(BASE, 'tok');
    const promise = client.get('/projects');
    await expect(promise).rejects.toMatchObject({
      code: 'http-error',
      status: 502,
    });
  });

  it('wraps transport failures as network-error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    const client = new SpaceClient(BASE, 'tok');
    const promise = client.get('/projects');
    await expect(promise).rejects.toBeInstanceOf(SpaceCliError);
    await expect(promise).rejects.toMatchObject({ code: 'network-error' });
  });

  it('wraps non-JSON 200 bodies as protocol-error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(200, '<html>oops</html>')));

    const client = new SpaceClient(BASE, 'tok');
    const promise = client.get('/projects');
    await expect(promise).rejects.toMatchObject({ code: 'protocol-error' });
  });
});
