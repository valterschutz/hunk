/**
 * Decides whether one change touches a displayed hunk, from unified-diff line spans.
 *
 * A span is the `start,count` pair of one side of a `@@` header. A span with lines covers
 * `start` through `start + count - 1`; an empty span (`count` 0) is the boundary just after
 * line `start`, where lines were inserted or removed on the other side, and `start` 0 is the
 * top of the file. The staging state of a working-tree hunk and the zero-context changes that
 * stage, unstage, or discard it are both found by asking which changes touch it.
 */

/** One side of a unified-diff hunk header: first line and line count. */
export interface LineSpan {
  start: number;
  count: number;
}

/**
 * Map a span onto doubled coordinates: line `n` sits at `2n`, the boundary after it at `2n + 1`.
 *
 * Doubling keeps boundaries and lines on one integer axis, so empty spans compare exactly.
 */
function doubledInterval({ start, count }: LineSpan): [number, number] {
  return count > 0 ? [2 * start, 2 * (start + count - 1)] : [2 * start + 1, 2 * start + 1];
}

/**
 * Return whether a change touches a hunk on the same side of the diff.
 *
 * A hunk owns the boundaries around its lines as well as the lines, so an insertion directly
 * above or below a hunk belongs to it; Git keeps unrelated changes at least one context window
 * apart, so a boundary is never contested by two displayed hunks. An empty hunk (a pure
 * insertion or removal on this side) owns only its own boundary and the lines a change replaced
 * around it.
 */
export function spanTouchesHunk(hunk: LineSpan, change: LineSpan) {
  const [hunkFrom, hunkTo] = doubledInterval(hunk);
  const [changeFrom, changeTo] = doubledInterval(change);
  // Widen whichever side has lines by its surrounding boundaries; two empty spans must match.
  const hunkPad = hunk.count > 0 ? 1 : 0;
  const changePad = hunk.count === 0 && change.count > 0 ? 1 : 0;
  return changeFrom - changePad <= hunkTo + hunkPad && hunkFrom - hunkPad <= changeTo + changePad;
}
