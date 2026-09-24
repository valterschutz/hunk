import type { ReviewHunkSpan } from "../review/geometry";

/**
 * The facts a hunk header is built from.
 *
 * Structural rather than the parser's own type, so a parsed hunk and a projected semantic
 * hunk both satisfy it and the header can never depend on which model a caller holds.
 */
export interface ReviewHunkHeaderSource extends ReviewHunkSpan {
  hunkSpecs?: string | null;
  hunkContext?: string | null;
}

/**
 * Format a unified-diff hunk header exactly as Hunk should display it.
 *
 * A parsed hunk carries Git's whole `@@` line in `hunkSpecs`, function context and
 * trailing newline included, while `hunkContext` repeats that context on its own. The
 * context is therefore appended only when the specs do not already end with it, so a
 * parsed header and a synthesized one both show it exactly once.
 */
export function formatHunkHeader(hunk: ReviewHunkHeaderSource) {
  const specs =
    hunk.hunkSpecs?.trimEnd() ??
    // The header count is the per-side line total (context + changes), i.e.
    // `*Count` parsed from `-X,count` / `+X,count` — not `*Lines`, which is
    // only the changed `+`/`-` lines and would undercount a context-bearing hunk.
    `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`;
  if (!hunk.hunkContext || specs.endsWith(` ${hunk.hunkContext}`)) {
    return specs;
  }
  return `${specs} ${hunk.hunkContext}`;
}
