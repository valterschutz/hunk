/**
 * Carries notes and the selection across a document reload that changed a file's content.
 *
 * A note is anchored to a line number, and a line number is only meaningful for the patch
 * it was written against. Editing the file above a note, or staging the hunk it sits in,
 * moves or removes the line while the number stays put, so without this pass the note is
 * drawn beside whatever text now occupies its old number. The reload therefore relocates
 * every note by the text of the line it was placed on: the same text, found again in the
 * new patch near its old position, is the same line. A line the new patch no longer shows
 * as part of a hunk is one whose change was staged, reverted, or rewritten, and the note
 * about that change goes with it.
 *
 * Both sides are handled alike, so a note on a deleted line follows old-side text and a
 * note on an added or context line follows new-side text.
 */
import { resolveReviewNoteAnchor, reviewGapOwnerHunkIndex } from "./anchors";
import type { ReviewSemanticSelection, ReviewStoredNote } from "./state";
import type {
  ReviewDocumentV1,
  ReviewFileV1,
  ReviewHunkV1,
  ReviewLineRange,
  ReviewSide,
} from "./types";

/** Whether a patch row is a changed line on its side or unchanged context. */
type ReviewLineKind = "context" | "change";

interface ReviewLineEntry {
  line: number;
  text: string;
  kind: ReviewLineKind;
  hunkIndex: number;
}

/** How many neighbouring lines on each side vote when several lines share one text. */
const CONTEXT_RADIUS = 2;

/** Every row one hunk shows on one side, in file order, with the text it carries. */
function hunkLineEntries(
  file: ReviewFileV1,
  hunk: ReviewHunkV1,
  side: ReviewSide,
): ReviewLineEntry[] {
  const texts = side === "new" ? file.additionLines : file.deletionLines;
  const entries: ReviewLineEntry[] = [];
  let line = side === "new" ? hunk.additionStart : hunk.deletionStart;
  for (const block of hunk.hunkContent) {
    const count =
      block.type === "context" ? block.lines : side === "new" ? block.additions : block.deletions;
    const index = side === "new" ? block.additionLineIndex : block.deletionLineIndex;
    for (let offset = 0; offset < count; offset += 1) {
      const text = texts[index + offset];
      if (text === undefined) {
        // A patch whose line arrays stop short is malformed; refusing to relocate is safer
        // than matching against undefined.
        return [];
      }
      entries.push({ line: line + offset, text, kind: block.type, hunkIndex: hunk.index });
    }
    line += count;
  }
  return entries;
}

/** Every row a file's patch shows on one side, keyed by line number. */
function fileLineEntries(file: ReviewFileV1, side: ReviewSide) {
  const byLine = new Map<number, ReviewLineEntry>();
  for (const hunk of file.hunks) {
    for (const entry of hunkLineEntries(file, hunk, side)) {
      byLine.set(entry.line, entry);
    }
  }
  return byLine;
}

/**
 * Find where one line of the previous patch went in the next patch.
 *
 * Only lines with exactly the same text qualify. Among them, the one whose neighbours also
 * match best wins, and the nearest line number breaks a tie, so a repeated blank line or
 * closing brace still resolves to the occurrence the note was written beside. Undefined
 * means the line is no longer part of any hunk on that side.
 */
export function relocateReviewLine(
  previous: ReviewFileV1,
  next: ReviewFileV1,
  side: ReviewSide,
  line: number,
): { line: number; kind: ReviewLineKind; previousKind: ReviewLineKind } | undefined {
  const previousLines = fileLineEntries(previous, side);
  const source = previousLines.get(line);
  if (!source) return undefined;

  const nextLines = fileLineEntries(next, side);
  let best: { entry: ReviewLineEntry; score: number; distance: number } | undefined;
  for (const entry of nextLines.values()) {
    if (entry.text !== source.text) continue;
    let score = 0;
    for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
      if (offset === 0) continue;
      const before = previousLines.get(line + offset);
      const after = nextLines.get(entry.line + offset);
      if (before && after && before.text === after.text) score += 1;
    }
    const distance = Math.abs(entry.line - line);
    if (
      !best ||
      score > best.score ||
      (score === best.score && distance < best.distance) ||
      (score === best.score && distance === best.distance && entry.line < best.entry.line)
    ) {
      best = { entry, score, distance };
    }
  }
  return best
    ? { line: best.entry.line, kind: best.entry.kind, previousKind: source.kind }
    : undefined;
}

/** Shift one inclusive range by a line delta. */
function shiftRange(range: ReviewLineRange | undefined, delta: number) {
  return range ? ([range[0] + delta, range[1] + delta] as ReviewLineRange) : undefined;
}

/** The line a note is placed beside, derived from its ranges when no preference was stored. */
function notePlacement(entry: ReviewStoredNote) {
  const { anchor } = entry.note;
  if (anchor.preferred) return anchor.preferred;
  if (anchor.newRange) return { side: "new" as const, line: anchor.newRange[0] };
  if (anchor.oldRange) return { side: "old" as const, line: anchor.oldRange[0] };
  return undefined;
}

/**
 * Re-anchor one root note against the next version of its file, or drop it.
 *
 * A note whose line text is found again moves with it. A note on a changed line whose
 * text now reads as unchanged context lost the change it was about, which is what staging
 * or reverting that hunk looks like from the diff, so it is dropped rather than left
 * hanging on an unrelated hunk.
 */
function reanchorRootNote(
  entry: ReviewStoredNote,
  previous: ReviewFileV1,
  next: ReviewFileV1,
): ReviewStoredNote | undefined {
  const placement = notePlacement(entry);
  if (!placement) return entry;

  const relocated = relocateReviewLine(previous, next, placement.side, placement.line);
  if (!relocated) {
    // A line the previous patch did not show either (an expanded-gap line) cannot be
    // followed by text; it keeps its number and only its owner hunk is refreshed.
    if (!fileLineEntries(previous, placement.side).has(placement.line)) {
      return withResolvedAnchor(entry, next, placement, 0);
    }
    return undefined;
  }
  if (relocated.previousKind === "change" && relocated.kind === "context") {
    return undefined;
  }
  return withResolvedAnchor(entry, next, placement, relocated.line - placement.line);
}

/** Rebuild a note's anchor against the next file's hunks after moving it by `delta` lines. */
function withResolvedAnchor(
  entry: ReviewStoredNote,
  next: ReviewFileV1,
  placement: { side: ReviewSide; line: number },
  delta: number,
): ReviewStoredNote {
  const { anchor } = entry.note;
  const oldRange = placement.side === "old" ? shiftRange(anchor.oldRange, delta) : anchor.oldRange;
  const newRange = placement.side === "new" ? shiftRange(anchor.newRange, delta) : anchor.newRange;
  const line = placement.line + delta;
  const resolved = resolveReviewNoteAnchor(next.hunks, {
    ...(oldRange ? { oldRange } : {}),
    ...(newRange ? { newRange } : {}),
    preferred: { side: placement.side, line },
    fallbackOwnerHunkIndex: reviewGapOwnerHunkIndex(next.hunks, placement.side, line),
  });
  return {
    note: { ...entry.note, anchor: resolved },
    resolution: "active",
  };
}

/**
 * Carry stored notes across a document change.
 *
 * Notes on files whose content is unchanged pass through untouched, including their array
 * identity when nothing moved at all. Notes on a file the next document no longer lists
 * are dropped: the file left the diff, so nothing remains to attach them to. Replies share
 * their root's anchor and follow its fate.
 */
export function reanchorReviewNotes(
  previous: ReviewDocumentV1,
  next: ReviewDocumentV1,
  notes: ReviewStoredNote[],
): ReviewStoredNote[] {
  const previousByKey = new Map(previous.files.map((file) => [file.key, file] as const));
  const nextByKey = new Map(next.files.map((file) => [file.key, file] as const));
  const byId = new Map(notes.map((entry) => [entry.note.id, entry] as const));

  /** The root of a thread, found by walking parent links through the previous list. */
  const rootOf = (entry: ReviewStoredNote) => {
    let current = entry;
    const seen = new Set<string>();
    while (current.note.parentId && !seen.has(current.note.id)) {
      seen.add(current.note.id);
      const parent = byId.get(current.note.parentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const rootOutcomes = new Map<string, ReviewStoredNote | undefined>();
  const outcomeForRoot = (root: ReviewStoredNote) => {
    if (rootOutcomes.has(root.note.id)) return rootOutcomes.get(root.note.id);
    const before = previousByKey.get(root.note.fileKey);
    const after = nextByKey.get(root.note.fileKey);
    let outcome: ReviewStoredNote | undefined;
    if (!after) {
      outcome = undefined;
    } else if (!before || before.contentIdentity === after.contentIdentity) {
      outcome = root;
    } else {
      outcome = reanchorRootNote(root, before, after);
    }
    rootOutcomes.set(root.note.id, outcome);
    return outcome;
  };

  let changed = false;
  const result: ReviewStoredNote[] = [];
  for (const entry of notes) {
    const root = rootOf(entry);
    const rootOutcome = outcomeForRoot(root);
    if (rootOutcome === undefined) {
      changed = true;
      continue;
    }
    if (root === entry) {
      if (rootOutcome !== entry) changed = true;
      result.push(rootOutcome);
    } else if (rootOutcome === root) {
      result.push(entry);
    } else {
      changed = true;
      result.push({ ...entry, note: { ...entry.note, anchor: rootOutcome.note.anchor } });
    }
  }
  return changed ? result : notes;
}

/**
 * Follow the selected hunk across a document change by the text it changed.
 *
 * The first changed line of the previously selected hunk identifies it; the hunk that now
 * shows that line is the same hunk, however many hunks were inserted or removed above it.
 * A hunk with no changed line left, or one the next patch does not show, keeps its index
 * for the consumer to clamp.
 */
export function reanchorReviewSelection(
  previous: ReviewDocumentV1,
  next: ReviewDocumentV1,
  selection: ReviewSemanticSelection,
): ReviewSemanticSelection {
  if (selection.fileKey === null) return selection;
  const before = previous.files.find((file) => file.key === selection.fileKey);
  const after = next.files.find((file) => file.key === selection.fileKey);
  if (!before || !after || before.contentIdentity === after.contentIdentity) return selection;
  const hunk = before.hunks[selection.hunkIndex];
  if (!hunk) return selection;

  for (const side of ["new", "old"] as const) {
    const entries = hunkLineEntries(before, hunk, side);
    const probe = entries.find((entry) => entry.kind === "change") ?? entries[0];
    if (!probe) continue;
    const relocated = relocateReviewLine(before, after, side, probe.line);
    if (!relocated) continue;
    const owner = fileLineEntries(after, side).get(relocated.line)?.hunkIndex;
    if (owner !== undefined && owner !== selection.hunkIndex) {
      return { fileKey: selection.fileKey, hunkIndex: owner };
    }
    return selection;
  }
  return selection;
}
