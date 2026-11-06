import { SpaceCliError } from './errors.js';

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * Minimal HTTP client for the Space `/api/http` REST surface.
 * Bearer-token auth; every non-2xx response becomes a `SpaceCliError`
 * carrying Space's own error code and description.
 */
export class SpaceClient {
  private readonly apiBase: string;

  constructor(baseUrl: string, private readonly token: string) {
    this.apiBase = `${baseUrl.replace(/\/+$/, '')}/api/http`;
  }

  /** GET a JSON resource. `path` is relative to `/api/http`, e.g. `/projects/IJ/code-reviews/...`. */
  async get<T = unknown>(path: string, params?: QueryParams): Promise<T> {
    const url = this.url(path, params);
    return this.request<T>('GET', url, path);
  }

  /**
   * POST a JSON body to an API resource and parse the JSON response.
   * A 200 with an empty body (Space does this for some mutations)
   * resolves to `undefined`.
   */
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = this.url(path);
    return this.request<T>('POST', url, path, body);
  }

  /** PATCH a JSON body to an API resource; same semantics as {@link post}. */
  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = this.url(path);
    return this.request<T>('PATCH', url, path, body);
  }

  private url(path: string, params?: QueryParams): URL {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request<T>(
    method: string,
    url: URL,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const request = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let response: Response;
    try {
      response = await fetch(request);
    } catch (e) {
      throw new SpaceCliError(
        'network-error',
        `request to ${url.href} failed: ${errorDetail(e)}`,
      );
    }
    return (await this.parseBody(response, url, path, method)) as T;
  }

  private async parseBody(
    response: Response,
    url: URL,
    path: string,
    method: string,
  ): Promise<unknown> {
    const text = await response.text();
    if (response.ok) {
      if (text === '') return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new SpaceCliError(
          'protocol-error',
          `Space returned a non-JSON 200 body for ${method} ${path}: ${text.slice(0, 200)}`,
        );
      }
    }

    // Error path: pass Space's envelope through verbatim when present.
    let body: unknown = undefined;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        // fall through to the generic http-error below
      }
    }
    if (isSpaceErrorEnvelope(body)) {
      throw new SpaceCliError(body.error, body.error_description, response.status);
    }
    throw new SpaceCliError(
      'http-error',
      `Space returned HTTP ${response.status} for ${method} ${path}` +
        (text === '' ? ' (empty body)' : `: ${text.slice(0, 200)}`),
      response.status,
    );
  }
}

/** Space's uniform error envelope: `{"error": "<code>", "error_description": "..."}`. */
function isSpaceErrorEnvelope(body: unknown): body is { error: string; error_description: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>).error === 'string' &&
    typeof (body as Record<string, unknown>).error_description === 'string'
  );
}

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
