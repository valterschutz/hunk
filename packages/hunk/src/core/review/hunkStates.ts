/**
 * Names the decisions a reviewer records on a hunk and the states the review stream filters by.
 *
 * Kept free of imports so launch options (`core/run`) can name these states without depending on
 * the review model.
 */

export type HunkDecision = "accepted" | "rejected" | "fixed";
export const HUNK_DECISIONS: readonly HunkDecision[] = ["accepted", "rejected", "fixed"];

/** What the review stream filters hunks by: undecided, or the decision a hunk carries. */
export type HunkState = "undecided" | HunkDecision;
export const HUNK_STATES: readonly HunkState[] = ["undecided", ...HUNK_DECISIONS];
