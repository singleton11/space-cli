import type { SpaceClient } from './http.js';
import { projectParam } from './project.js';

export type ReviewDecision = 'accept' | 'accept-and-finalize' | 'request-changes';

/** Submit a reviewer decision as the authenticated user. */
export async function submitReviewDecision(
  client: SpaceClient,
  project: string,
  reviewId: string,
  decision: ReviewDecision,
): Promise<{ reviewId: string; decision: ReviewDecision }> {
  const path = `/projects/${encodeURIComponent(projectParam(project))}/code-reviews/${encodeURIComponent(reviewId)}`;
  if (decision === 'request-changes') {
    await client.put(`${path}/wait-author-reply`);
  } else {
    await client.put(`${path}/accept-changes`, { forever: decision === 'accept-and-finalize' });
  }
  return { reviewId, decision };
}
