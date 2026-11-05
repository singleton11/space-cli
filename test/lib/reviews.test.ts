import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpaceCliError } from '../../src/lib/errors.js';
import { DEFAULT_LIST_LIMIT, getReview, listReviews, normalizeReview, normalizeReviewSummary } from '../../src/lib/reviews.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '../../fixtures', name), 'utf8'),
  ) as Record<string, unknown>;
}

describe('normalizeReview — golden tests against Step 0 fixtures', () => {
  it('maps a MergeRequestRecord (fixtures/review-show.json)', () => {
    const review = normalizeReview(fixture('review-show.json'));
    const raw = fixture('review-show.json');
    expect(review.kind).toBe('mergeRequest');
    expect(review.id).toBe(raw.id);
    expect(review.number).toBe(raw.number);
    expect(review.state).toBe('Opened');
    expect(review.repository).toBe('ultimate');
    expect(review.sourceBranch).toBe(
      (raw.branchPair as Record<string, unknown>).sourceBranch as string,
    );
    expect(review.targetBranch).toBe(
      (raw.branchPair as Record<string, unknown>).targetBranch as string,
    );
    expect(review.authors).toEqual(['1kkPrV2CjbGH']);
    expect(review.reviewers).toEqual([]);
    expect(review.discussionCounter).toEqual(
      raw.discussionCounter as Record<string, number>,
    );
    expect(review.commits).toHaveLength((raw.commits as unknown[]).length);
    expect(review.commits[0]).toEqual({
      repositoryId: '2gCefs2ORyRU',
      commitId: '51399e6c3b5264f245ac9ff0dec41e143a52d441',
    });
    expect(review.feedChannelId).toBe(raw.feedChannelId);
    expect(review.createdAt).toBe(raw.createdAt);
  });

  it('maps a CommitSetReviewRecord without branchPair (fixtures/review-own.json)', () => {
    const review = normalizeReview(fixture('review-own.json'));
    expect(review.kind).toBe('commitSetReview');
    expect(review.repository).toBeNull();
    expect(review.sourceBranch).toBeNull();
    expect(review.targetBranch).toBeNull();
    expect(review.createdAt).toBeNull(); // not present on commit-set records
    expect(review.authors).toEqual([]);
    expect(review.reviewers).toEqual([]); // null in the fixture
    expect(review.discussionCounter).not.toBeNull();
  });

  it('rejects unknown record classNames', () => {
    expect(() => normalizeReview({ className: 'SomethingElse', id: 'x' })).toThrowError(
      /unexpected review record className/,
    );
    try {
      normalizeReview({ className: 'SomethingElse', id: 'x' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpaceCliError);
      expect((e as SpaceCliError).code).toBe('protocol-error');
    }
  });
});

describe('getReview', () => {
  it('requests the pinned endpoint with the $fields projection and encodes segments', async () => {
    const calls: Array<{ path: string; params?: unknown }> = [];
    const fakeClient = {
      async get<T>(path: string, params?: unknown): Promise<T> {
        calls.push({ path, params });
        return fixture('review-show.json') as T;
      },
    };
    const review = await getReview(fakeClient, 'key:IJ', '2AomjG0QgoiG');
    expect(calls).toEqual([
      {
        path: '/projects/key%3AIJ/code-reviews/2AomjG0QgoiG',
        params: {
          $fields:
            'id,number,title,state,createdAt,feedChannelId,branchPair,participants,reviewers,discussionCounter,commits',
        },
      },
    ]);
    expect(review.kind).toBe('mergeRequest');
  });

  it('maps a 200 null body (missing review) to not-found', async () => {
    const fakeClient = {
      async get<T>(): Promise<T> {
        return null as T;
      },
    };
    await expect(getReview(fakeClient, 'key:IJ', 'nope')).rejects.toMatchObject({
      code: 'not-found',
      description: 'Review nope not found in project key:IJ',
    });
  });

  it('maps a non-object 200 body to protocol-error', async () => {
    const fakeClient = {
      async get<T>(): Promise<T> {
        return ['unexpected'] as T;
      },
    };
    await expect(getReview(fakeClient, 'key:IJ', 'x')).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });
});

describe('normalizeReviewSummary — golden test against M2 fixture', () => {
  it('maps all items of fixtures/reviews-list.json (MRs with branchPair)', () => {
    const raw = fixture('reviews-list.json');
    const items = raw.data as Array<{ review: Record<string, unknown> }>;
    expect(items.length).toBeGreaterThan(0);
    const summaries = items.map((item) => normalizeReviewSummary(item.review));
    for (let i = 0; i < items.length; i++) {
      const r = items[i]!.review;
      const s = summaries[i]!;
      expect(s.id).toBe(r.id);
      expect(s.kind).toBe('mergeRequest'); // fixture captured with type=MergeRequest
      expect(s.number).toBe(r.number);
      expect(s.title).toBe(r.title);
      expect(s.state).toBe(r.state);
      expect(s.createdAt).toBe(r.createdAt);
      const bp = (r.branchPair ?? null) as Record<string, unknown> | null;
      expect(s.repository).toBe(bp ? bp.repository : null);
      expect(s.sourceBranch).toBe(bp ? bp.sourceBranch : null);
      expect(s.targetBranch).toBe(bp ? bp.targetBranch : null);
      expect(s.discussionCounter).toEqual(r.discussionCounter as Record<string, number>);
    }
  });
  it('normalizes createdAt: 0 (commit-set list items) to null', () => {
    const s = normalizeReviewSummary({ className: 'CommitSetReviewRecord', id: 'x', createdAt: 0 });
    expect(s.createdAt).toBeNull();
    expect(s.kind).toBe('commitSetReview');
    expect(s.repository).toBeNull();
  });
  it('rejects items without a review record', () => {
    expect(() => normalizeReviewSummary(null)).toThrowError(/without a review record/);
  });
});

describe('listReviews', () => {
  interface Call { path: string; params: Record<string, unknown> }
  function recordingClient(pages: unknown[][]): { calls: Call[]; client: unknown } {
    const calls: Call[] = [];
    let page = 0;
    return {
      calls,
      client: {
        async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
          calls.push({ path, params: params ?? {} });
          const data = pages[Math.min(page, pages.length - 1)] ?? [];
          page += 1;
          return { totalCount: pages.flat().length, data } as T;
        },
      },
    };
  }
  function mr(id: string): Record<string, unknown> {
    return { review: { className: 'MergeRequestRecord', id } };
  }

  it('requests the pinned endpoint, projection, and passes filters through', async () => {
    const { calls, client } = recordingClient([[]]);
    const result = await listReviews(client as never, 'IJ', {
      state: 'Opened',
      text: 'mcp',
      author: '3f5nLE2wzNYi',
      reviewer: '2cyLNl2Vbm76',
      repository: 'ultimate',
    });
    expect(result.reviews).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(calls).toEqual([
      {
        path: '/projects/key%3AIJ/code-reviews',
        params: {
          state: 'Opened',
          text: 'mcp',
          author: '3f5nLE2wzNYi',
          reviewer: '2cyLNl2Vbm76',
          repository: 'ultimate',
          $skip: 0,
          $top: DEFAULT_LIST_LIMIT, // default limit caps the first page
          $fields:
            'data(review(id,number,title,state,createdAt,discussionCounter,branchPair)),totalCount',
        },
      },
    ]);
  });
  it('paginates with $skip/$top until the limit is reached', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => mr(`a${i}`));
    const page2 = Array.from({ length: 50 }, (_, i) => mr(`b${i}`));
    const { calls, client } = recordingClient([page1, page2]);
    const result = await listReviews(client as never, 'key:IJ', {}, 150);
    expect(result.reviews).toHaveLength(150);
    expect(result.totalCount).toBe(150);
    expect(calls.map((c) => c.params.$skip)).toEqual([0, 100]);
    expect(calls.map((c) => c.params.$top)).toEqual([100, 50]);
  });
  it('stops on an empty page and truncates defensively to the limit', async () => {
    const { client } = recordingClient([Array.from({ length: 7 }, (_, i) => mr(`a${i}`)), []]);
    const result = await listReviews(client as never, 'IJ', {}, 5);
    expect(result.reviews).toHaveLength(5);
  });
  it('uses the documented default limit', async () => {
    const { calls, client } = recordingClient([[]]);
    await listReviews(client as never, 'IJ');
    expect(calls[0]!.params.$top).toBe(DEFAULT_LIST_LIMIT);
  });
  it('rejects non-positive limits as usage errors', async () => {
    const { client } = recordingClient([[]]);
    await expect(listReviews(client as never, 'IJ', {}, 0)).rejects.toMatchObject({
      code: 'usage-error',
    });
    await expect(listReviews(client as never, 'IJ', {}, -3)).rejects.toMatchObject({
      code: 'usage-error',
    });
  });
});
