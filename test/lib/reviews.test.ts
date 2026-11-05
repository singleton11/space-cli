import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpaceCliError } from '../../src/lib/errors.js';
import { getReview, normalizeReview } from '../../src/lib/reviews.js';

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
