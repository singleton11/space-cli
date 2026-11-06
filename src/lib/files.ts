import type { SpaceClient } from './http.js';
import { SpaceCliError } from './errors.js';
import { asArray, asRecord, prop, stringOrNull } from './json.js';

/*
 * Pinned live (M3 probe, 2026-11-05, jetbrains.team):
 * - `GET .../repositories/{repo}/files?commit&path` lists the entry at `path`
 *   (a directory path lists its children) as `[{path, blob, type}]`, ~35 ms.
 *   A path missing at that commit → `[]`; an unknown commit → 404 `not-found`.
 * - `GET .../repositories/{repo}/text-content?commit&path` → `{type, lines[]}`,
 *   ~350 ms (server-side highlighting). `type` is TEXT | LARGE | LINK | IMAGE |
 *   BINARY_OTHER; non-TEXT files come back with `lines: []`. Missing file or
 *   commit → 404 `not-found`. The `type,lines(text)` projection cuts the body ~4×.
 * - Paths take no leading `/`.
 */
const FILES_FIELDS = 'path,blob,type';
const TEXT_FIELDS = 'type,lines(text)';

/**
 * Read-only file access at a revision, scoped to one project. Every lookup is
 * memoized per (repository, revision, path): many comments share a file.
 * "Not there" (missing file/commit, non-text content) is `null`; any other
 * API failure propagates.
 */
export class RepositoryFiles {
  private readonly blobs = new Map<string, Promise<string | null>>();
  private readonly texts = new Map<string, Promise<string[] | null>>();

  constructor(
    private readonly client: SpaceClient,
    private readonly projectPath: string,
  ) {}

  /** Git blob id of the file at `revision`, or `null` if it doesn't exist there. */
  blob(repository: string, revision: string, path: string): Promise<string | null> {
    return memo(this.blobs, key(repository, revision, path), async () => {
      const raw = await notFoundAsNull(
        this.client.get<unknown>(this.repoPath(repository, 'files'), {
          commit: revision,
          path,
          $fields: FILES_FIELDS,
        }),
      );
      const entry = asArray(raw).find((e) => stringOrNull(prop(e, 'path')) === path);
      if (entry === undefined || prop(entry, 'type') === 'DIR') return null;
      return stringOrNull(prop(entry, 'blob'));
    });
  }

  /** The file's lines at `revision`, or `null` if it doesn't exist there or isn't text. */
  textLines(repository: string, revision: string, path: string): Promise<string[] | null> {
    return memo(this.texts, key(repository, revision, path), async () => {
      const raw = await notFoundAsNull(
        this.client.get<unknown>(this.repoPath(repository, 'text-content'), {
          commit: revision,
          path,
          $fields: TEXT_FIELDS,
        }),
      );
      const record = asRecord(raw);
      if (record === null || prop(record, 'type') !== 'TEXT') return null;
      return asArray(prop(record, 'lines')).map((line) => stringOrNull(prop(line, 'text')) ?? '');
    });
  }

  private repoPath(repository: string, endpoint: string): string {
    return `/projects/${this.projectPath}/repositories/${encodeURIComponent(repository)}/${endpoint}`;
  }
}

function key(repository: string, revision: string, path: string): string {
  return `${repository}\0${revision}\0${path}`;
}

function memo<T>(cache: Map<string, Promise<T>>, k: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(k);
  if (pending === undefined) {
    pending = load();
    cache.set(k, pending);
  }
  return pending;
}

async function notFoundAsNull(request: Promise<unknown>): Promise<unknown> {
  try {
    return await request;
  } catch (e) {
    if (e instanceof SpaceCliError && e.code === 'not-found') return null;
    throw e;
  }
}
