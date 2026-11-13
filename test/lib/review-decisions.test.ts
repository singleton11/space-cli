import { describe, expect, it } from 'vitest';
import { submitReviewDecision, type ReviewDecision } from '../../src/lib/review-decisions.js';
import { SpaceCliError } from '../../src/lib/errors.js';
import { routingClient } from '../support.js';

describe('submitReviewDecision', () => {
  it.each<[ReviewDecision, string, unknown]>([
    ['accept', 'accept-changes', { forever: false }],
    ['accept-and-finalize', 'accept-changes', { forever: true }],
    ['request-changes', 'wait-author-reply', undefined],
  ])('submits %s', async (decision, endpoint, body) => {
    const { client, calls } = routingClient([{ test: () => true, body: undefined }]);
    expect(await submitReviewDecision(client, 'IJ', 'review/1', decision)).toEqual({
      reviewId: 'review/1', decision,
    });
    expect(calls).toEqual([{
      method: 'put', path: `/projects/key%3AIJ/code-reviews/review%2F1/${endpoint}`, params: {}, body,
    }]);
  });

  it('propagates API errors without reporting success', async () => {
    const { client } = routingClient([{ test: () => true, respond: () => {
      throw new SpaceCliError('forbidden', 'Not allowed', 403);
    } }]);
    await expect(submitReviewDecision(client, 'IJ', 'review', 'accept')).rejects.toMatchObject({
      code: 'forbidden', status: 403,
    });
  });
});
