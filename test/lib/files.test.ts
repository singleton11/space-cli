import { describe, expect, it } from 'vitest';
import { SpaceCliError } from '../../src/lib/errors.js';
import { RepositoryFiles } from '../../src/lib/files.js';
import { filesRoute, fixture, notFound, routingClient } from '../support.js';

const PROJECT_PATH = 'key%3AIJ';
const STARTER = 'language-server/features-impl/mcp/src/LSMcpStarter.kt';
const A18B = 'a18bbf70a13273e3e493f1cbd7787f618ad6d97c';

describe('RepositoryFiles.blob', () => {
  it('reads the blob id from a real files response (golden)', async () => {
    const { calls, client } = routingClient([filesRoute()]);
    const files = new RepositoryFiles(client, PROJECT_PATH);
    expect(await files.blob('ultimate', A18B, STARTER)).toBe('479d543336b56b2d1fe8bb266c16c6ea96d524b8');
    expect(calls).toEqual([
      {
        method: 'get',
        path: '/projects/key%3AIJ/repositories/ultimate/files',
        params: { commit: A18B, path: STARTER, $fields: 'path,blob,type' },
      },
    ]);
  });

  it('null for a path missing at the commit ([]) or an unknown commit (404)', async () => {
    const { client } = routingClient([
      { test: (_p, params) => params.commit === 'gone', respond: notFound },
      { test: () => true, body: [] },
    ]);
    const files = new RepositoryFiles(client, PROJECT_PATH);
    expect(await files.blob('ultimate', 'head', 'deleted.kt')).toBeNull();
    expect(await files.blob('ultimate', 'gone', 'a.kt')).toBeNull();
  });

  it('only an exact path match counts — a directory path lists children, and DIR entries are not files', async () => {
    const { client } = routingClient([
      {
        test: () => true,
        body: [
          { path: 'dir/child.kt', blob: 'c', type: 'FILE' },
          { path: 'dir/sub', blob: 's', type: 'DIR' },
        ],
      },
    ]);
    const files = new RepositoryFiles(client, PROJECT_PATH);
    expect(await files.blob('r', 'rev', 'dir')).toBeNull();
    expect(await files.blob('r', 'rev', 'dir/sub')).toBeNull();
    expect(await files.blob('r', 'rev', 'dir/child.kt')).toBe('c');
  });

  it('propagates errors other than not-found', async () => {
    const { client } = routingClient([
      {
        test: () => true,
        respond: () => {
          throw new SpaceCliError('internal-server-error', 'boom', 500);
        },
      },
    ]);
    await expect(new RepositoryFiles(client, PROJECT_PATH).blob('r', 'rev', 'a.kt')).rejects.toMatchObject({
      code: 'internal-server-error',
    });
  });

  it('memoizes per (repository, revision, path), including concurrent callers', async () => {
    const { calls, client } = routingClient([filesRoute()]);
    const files = new RepositoryFiles(client, PROJECT_PATH);
    await Promise.all([files.blob('ultimate', A18B, STARTER), files.blob('ultimate', A18B, STARTER)]);
    await files.blob('ultimate', A18B, STARTER);
    await files.blob('other', A18B, STARTER);
    expect(calls).toHaveLength(2);
  });
});

describe('RepositoryFiles.textLines', () => {
  it('returns line texts from the lean text-content projection (golden)', async () => {
    const { calls, client } = routingClient([{ test: () => true, body: fixture('text-content-lean.json') }]);
    const lines = await new RepositoryFiles(client, 'key%3AAMPER').textLines('amper', 'rev', 'KnownAgents.kt');
    expect(lines).toHaveLength(96);
    expect(calls[0]).toEqual({
      method: 'get',
      path: '/projects/key%3AAMPER/repositories/amper/text-content',
      params: { commit: 'rev', path: 'KnownAgents.kt', $fields: 'type,lines(text)' },
    });
  });

  it('accepts the full (unprojected) response shape too (golden)', async () => {
    const { client } = routingClient([{ test: () => true, body: fixture('text-content-at-revision.json') }]);
    const lines = await new RepositoryFiles(client, PROJECT_PATH).textLines('ultimate', 'rev', 'mcp.kt');
    expect(lines![71]).toBe('    service<LspMcpServerStatusPublisher>()');
  });

  it('null for non-text content (pinned live: images come back as type IMAGE, lines [])', async () => {
    const { client } = routingClient([{ test: () => true, body: { type: 'IMAGE', lines: [] } }]);
    expect(await new RepositoryFiles(client, PROJECT_PATH).textLines('r', 'rev', 'share.png')).toBeNull();
  });

  it('null when the file or commit is missing (404 not-found)', async () => {
    const { client } = routingClient([{ test: () => true, respond: notFound }]);
    expect(await new RepositoryFiles(client, PROJECT_PATH).textLines('r', 'rev', 'gone.kt')).toBeNull();
  });
});
