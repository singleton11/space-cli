import { describe, expect, it } from 'vitest';
import { fetchReviewRevisions, reviewRevisionsFromDetails } from '../../src/lib/revisions.js';
import { fixture, routingClient } from '../support.js';

describe('reviewRevisionsFromDetails — golden', () => {
  it('merge request (IJ #232805): head is the chain tip, base the parent of the first commit', () => {
    const revisions = reviewRevisionsFromDetails(fixture('review-details-commits.json'));
    expect([...revisions.keys()]).toEqual(['ultimate']);
    expect(revisions.get('ultimate')).toEqual({
      head: 'cc72ec4640bf07e224abe7b3e608e82dd5975c4e', // == branchPair.sourceBranchRef, pinned live
      base: '762d56bf38f056586acbb3b110b94cc9c0fd583f',
    });
  });

  it('commit-set review of disjoint commits (AMPER #3842): newest tip is head, base is unknown', () => {
    // A 4-commit chain (8cda5c13 … 7e96a7d0) plus an older standalone commit 7911192f.
    const revisions = reviewRevisionsFromDetails(fixture('review-details-csr.json'));
    expect(revisions.get('amper')).toEqual({ head: '8cda5c13c024f194e7aed2d9a2f14e2670c3214a', base: null });
  });
});

describe('reviewRevisionsFromDetails — shapes', () => {
  it('tolerates empty, null, and malformed bodies', () => {
    expect(reviewRevisionsFromDetails(null).size).toBe(0);
    expect(reviewRevisionsFromDetails({ commits: [] }).size).toBe(0);
    expect(reviewRevisionsFromDetails({ commits: [{ repository: {}, commits: [] }] }).size).toBe(0);
    expect(reviewRevisionsFromDetails({ commits: [{ repository: { name: 'r' }, commits: [] }] }).get('r')).toEqual({
      head: null,
      base: null,
    });
  });

  it('a merge commit pulled in from the target keeps the original root and base', () => {
    const revisions = reviewRevisionsFromDetails({
      commits: [
        {
          repository: { name: 'r' },
          commits: [
            { commit: { id: 'c3', parents: ['m'], commitDate: 3 } },
            { commit: { id: 'm', parents: ['c1', 'master-tip'], commitDate: 2 } },
            { commit: { id: 'c1', parents: ['fork'], commitDate: 1 } },
          ],
        },
      ],
    });
    expect(revisions.get('r')).toEqual({ head: 'c3', base: 'fork' });
  });
});

describe('fetchReviewRevisions', () => {
  it('requests the details projection under the review path', async () => {
    const { calls, client } = routingClient([{ test: () => true, body: fixture('review-details-commits.json') }]);
    await fetchReviewRevisions(client, 'key%3AIJ/code-reviews/r1');
    expect(calls).toEqual([
      {
        path: '/projects/key%3AIJ/code-reviews/r1/details',
        params: { $fields: 'commits(repository(name),commits(commit(id,parents,commitDate)))' },
      },
    ]);
  });
});
