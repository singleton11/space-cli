import { describe, expect, it } from 'vitest';
import { buildDiffContext, isOutdated } from '../../src/lib/anchors.js';
import type { CommentAnchor } from '../../src/lib/comments.js';
import type { RepositoryFiles } from '../../src/lib/files.js';
import type { RepositoryRevisions } from '../../src/lib/revisions.js';

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

function anchor(overrides: Partial<CommentAnchor> = {}): CommentAnchor {
  return {
    file: 'src/a.kt',
    repository: 'repo',
    line: 10,
    oldLine: null,
    revision: 'rev',
    end: null,
    snippet: [],
    ...overrides,
  };
}

describe('buildDiffContext', () => {
  it('slices N lines before and after a single-line anchor, 1-based', () => {
    const ctx = buildDiffContext(FILE, anchor(), 2)!;
    expect(ctx).toEqual({
      revision: 'rev',
      side: 'new',
      lines: [8, 9, 10, 11, 12].map((n) => ({ line: n, text: `line ${n}` })),
    });
  });

  it('N = 0 returns just the anchored line', () => {
    expect(buildDiffContext(FILE, anchor(), 0)!.lines).toEqual([{ line: 10, text: 'line 10' }]);
  });

  it('clamps at the start and end of the file', () => {
    expect(buildDiffContext(FILE, anchor({ line: 2 }), 5)!.lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(buildDiffContext(FILE, anchor({ line: 19 }), 5)!.lines.map((l) => l.line)).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('widens over a range whose end is on the same revision', () => {
    const ctx = buildDiffContext(FILE, anchor({ line: 5, end: { line: 8, oldLine: null, revision: 'rev' } }), 1)!;
    expect(ctx.lines.map((l) => l.line)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('ignores a range end on another revision (range spanning both diff sides)', () => {
    const ctx = buildDiffContext(
      FILE,
      anchor({ line: null, oldLine: 5, end: { line: 15, oldLine: null, revision: 'other' } }),
      1,
    )!;
    expect(ctx.side).toBe('old');
    expect(ctx.lines.map((l) => l.line)).toEqual([4, 5, 6]);
  });

  it('uses oldLine coordinates for left-side anchors, including left-side range ends', () => {
    const ctx = buildDiffContext(
      FILE,
      anchor({ line: null, oldLine: 3, end: { line: null, oldLine: 4, revision: 'rev' } }),
      0,
    )!;
    expect(ctx).toMatchObject({ side: 'old', lines: [{ line: 3 }, { line: 4 }] });
  });

  it('is null when the anchor has no line or lies outside the file', () => {
    expect(buildDiffContext(FILE, anchor({ line: null, oldLine: null }), 3)).toBeNull();
    expect(buildDiffContext(FILE, anchor({ line: 21 }), 3)).toBeNull();
    expect(buildDiffContext([], anchor({ line: 1 }), 3)).toBeNull();
  });
});

describe('isOutdated', () => {
  const revisions = new Map<string, RepositoryRevisions>([['repo', { head: 'head', base: 'base' }]]);

  /** A RepositoryFiles double: blob ids by `<revision>:<path>`; unknown → missing (null). */
  function files(blobs: Record<string, string>): { files: RepositoryFiles; lookups: string[] } {
    const lookups: string[] = [];
    const double = {
      async blob(_repository: string, revision: string, path: string) {
        lookups.push(`${revision}:${path}`);
        return blobs[`${revision}:${path}`] ?? null;
      },
    };
    return { files: double as unknown as RepositoryFiles, lookups };
  }

  it('false without any lookup when the anchor revision is the review head', async () => {
    const f = files({});
    expect(await isOutdated(anchor({ revision: 'head' }), revisions, f.files)).toBe(false);
    expect(f.lookups).toEqual([]);
  });

  it('false when the file blob is identical at the review head (e.g. after a rebase)', async () => {
    const f = files({ 'rev:src/a.kt': 'b1', 'head:src/a.kt': 'b1' });
    expect(await isOutdated(anchor(), revisions, f.files)).toBe(false);
  });

  it('true when the file changed, was deleted at head, or is missing at the anchor revision', async () => {
    expect(await isOutdated(anchor(), revisions, files({ 'rev:src/a.kt': 'b1', 'head:src/a.kt': 'b2' }).files)).toBe(true);
    expect(await isOutdated(anchor(), revisions, files({ 'rev:src/a.kt': 'b1' }).files)).toBe(true);
    expect(await isOutdated(anchor(), revisions, files({ 'head:src/a.kt': 'b1' }).files)).toBe(true);
  });

  it('left-side anchors compare against the review base, not the head', async () => {
    const left = anchor({ line: null, oldLine: 4, revision: 'old' });
    const f = files({ 'old:src/a.kt': 'b0', 'base:src/a.kt': 'b0', 'head:src/a.kt': 'b9' });
    expect(await isOutdated(left, revisions, f.files)).toBe(false);
    expect(f.lookups).toEqual(['old:src/a.kt', 'base:src/a.kt']);
  });

  it('true when the base is unknown (disjoint commit-set review) or the repository is not in the review', async () => {
    const left = anchor({ line: null, oldLine: 4, revision: 'old' });
    const noBase = new Map([['repo', { head: 'head', base: null }]]);
    expect(await isOutdated(left, noBase, files({}).files)).toBe(true);
    expect(await isOutdated(anchor({ repository: 'elsewhere' }), revisions, files({}).files)).toBe(true);
    expect(await isOutdated(anchor({ repository: null }), revisions, files({}).files)).toBe(true);
  });

  it('a range is current only if both ends are', async () => {
    const range = anchor({ line: null, oldLine: 4, revision: 'old', end: { line: 9, oldLine: null, revision: 'new' } });
    const both = files({ 'old:src/a.kt': 'b0', 'base:src/a.kt': 'b0', 'new:src/a.kt': 'b1', 'head:src/a.kt': 'b1' });
    expect(await isOutdated(range, revisions, both.files)).toBe(false);
    const endChanged = files({ 'old:src/a.kt': 'b0', 'base:src/a.kt': 'b0', 'new:src/a.kt': 'b1', 'head:src/a.kt': 'b2' });
    expect(await isOutdated(range, revisions, endChanged.files)).toBe(true);
  });
});
