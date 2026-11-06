import type { AnchorEnd, CommentAnchor, DiffContext } from './comments.js';
import type { RepositoryFiles } from './files.js';
import type { RepositoryRevisions } from './revisions.js';

type Side = 'new' | 'old';
type AnchorPoint = Pick<AnchorEnd, 'line' | 'oldLine' | 'revision'>;

/**
 * Slice the file (as it was at `anchor.revision`) around the anchor:
 * `contextLines` before the first and after the last anchored line. A
 * multi-line range widens the slice when its end lies on the same revision;
 * an end on another revision (a range spanning both diff sides) can't be
 * placed in this file and is ignored. Line numbers are 1-based.
 *
 * Returns `null` when the anchor has no line or lies outside the file.
 */
export function buildDiffContext(
  fileLines: readonly string[],
  anchor: CommentAnchor,
  contextLines: number,
): DiffContext | null {
  const side = anchorSide(anchor);
  if (side === null || anchor.revision === null) return null;
  const start = coordinate(anchor, side)!;
  let end = start;
  if (anchor.end !== null && anchor.end.revision === anchor.revision) {
    end = coordinate(anchor.end, side) ?? start;
  }
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  if (first < 1 || first > fileLines.length) return null;
  const from = Math.max(1, first - contextLines);
  const to = Math.min(fileLines.length, last + contextLines);
  return {
    revision: anchor.revision,
    side,
    lines: fileLines.slice(from - 1, to).map((text, i) => ({ line: from + i, text })),
  };
}

/**
 * `false` only when every anchor point (start, and end for ranges) provably
 * still addresses the same code in the current review: its file has the same
 * git blob at the review head (right-side points) or base (left-side points).
 * Anything unprovable — file changed, moved or deleted; revision gone;
 * repository or base unknown — is `true`.
 */
export async function isOutdated(
  anchor: CommentAnchor,
  revisions: ReadonlyMap<string, RepositoryRevisions>,
  files: RepositoryFiles,
): Promise<boolean> {
  const points: AnchorPoint[] = anchor.end === null ? [anchor] : [anchor, anchor.end];
  const current = await Promise.all(
    points.map((point) => isPointCurrent(anchor.repository, anchor.file, point, revisions, files)),
  );
  return !current.every(Boolean);
}

async function isPointCurrent(
  repository: string | null,
  file: string,
  point: AnchorPoint,
  revisions: ReadonlyMap<string, RepositoryRevisions>,
  files: RepositoryFiles,
): Promise<boolean> {
  if (repository === null || point.revision === null) return false;
  const review = revisions.get(repository);
  const target = anchorSide(point) === 'old' ? review?.base : review?.head;
  if (target === undefined || target === null) return false;
  if (target === point.revision) return true;
  const [then, now] = await Promise.all([
    files.blob(repository, point.revision, file),
    files.blob(repository, target, file),
  ]);
  return then !== null && then === now;
}

function anchorSide(point: AnchorPoint): Side | null {
  if (point.line !== null) return 'new';
  if (point.oldLine !== null) return 'old';
  return null;
}

function coordinate(point: AnchorPoint, side: Side): number | null {
  return side === 'new' ? point.line : point.oldLine;
}
