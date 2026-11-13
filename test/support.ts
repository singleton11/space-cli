import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SpaceCliError } from '../src/lib/errors.js';

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures', name), 'utf8')) as T;
}

export type Params = Record<string, string | number | boolean | undefined | null>;
export interface Call {
  method: 'get' | 'post' | 'put' | 'patch';
  path: string;
  params: Params;
  body?: unknown;
}
/** `body` is returned as-is; `respond` computes the body (and may throw to simulate API errors). */
export type Route = { test: (path: string, params: Params) => boolean } & (
  | { body: unknown }
  | { respond: (path: string, params: Params) => unknown }
);

/** A SpaceClient double that records every request and routes by path/params. */
export function routingClient(routes: Route[]): { calls: Call[]; client: never } {
  const calls: Call[] = [];
  const client = {
    async get<T>(path: string, params?: Params): Promise<T> {
      return route<T>(calls, routes, 'get', path, params ?? {}, undefined);
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      return route<T>(calls, routes, 'post', path, {}, body);
    },
    async put<T>(path: string, body?: unknown): Promise<T> {
      return route<T>(calls, routes, 'put', path, {}, body);
    },
    async patch<T>(path: string, body?: unknown): Promise<T> {
      return route<T>(calls, routes, 'patch', path, {}, body);
    },
  };
  return { calls, client: client as never };
}

function route<T>(
  calls: Call[],
  routes: Route[],
  method: Call['method'],
  path: string,
  params: Params,
  body: unknown,
): T {
  calls.push({ method, path, params: { ...params }, body });
  for (const route of routes) {
    if (!route.test(path, params)) continue;
    return ('respond' in route ? route.respond(path, params) : route.body) as T;
  }
  throw new Error(`no route for ${method.toUpperCase()} ${path}`);
}

export function notFound(): never {
  throw new SpaceCliError('not-found', 'Cannot find file', 404);
}

/**
 * Serves `.../repositories/{repo}/files` from the `files-blobs.json` bundle:
 * real responses captured live, keyed `<commit>:<path>`. Unknown keys → `[]`
 * (what Space answers for a path missing at a commit).
 */
export function filesRoute(bundle: Record<string, unknown> = fixture('files-blobs.json')): Route {
  return {
    test: (p) => /\/repositories\/[^/]+\/files$/.test(p),
    respond: (_p, params) => bundle[`${String(params.commit)}:${String(params.path)}`] ?? [],
  };
}
