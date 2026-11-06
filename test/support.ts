import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SpaceCliError } from '../src/lib/errors.js';

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures', name), 'utf8')) as T;
}

export type Params = Record<string, string | number | boolean | undefined | null>;
export interface Call {
  path: string;
  params: Params;
}
/** `body` is returned as-is; `respond` computes the body (and may throw to simulate API errors). */
export type Route = { test: (path: string, params: Params) => boolean } & (
  | { body: unknown }
  | { respond: (path: string, params: Params) => unknown }
);

/** A SpaceClient double that records every GET and routes by path/params. */
export function routingClient(routes: Route[]): { calls: Call[]; client: never } {
  const calls: Call[] = [];
  const client = {
    async get<T>(path: string, params?: Params): Promise<T> {
      calls.push({ path, params: { ...(params ?? {}) } });
      for (const route of routes) {
        if (!route.test(path, params ?? {})) continue;
        return ('respond' in route ? route.respond(path, params ?? {}) : route.body) as T;
      }
      throw new Error(`no route for GET ${path}`);
    },
  };
  return { calls, client: client as never };
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
