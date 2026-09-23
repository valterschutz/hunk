import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import { reanchorReviewNotes, reanchorReviewSelection, relocateReviewLine } from "./reanchor";
import type { ReviewStoredNote } from "./state";
import type { ReviewDocumentV1, ReviewSide } from "./types";

const BASE = lines(
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
);

/** Project one working-tree file (index text versus working text) as a review document. */
function documentOf(before: string, after: string, path = "sample.txt"): ReviewDocumentV1 {
  return projectReviewDocument(
    [createTestDiffFile({ before, after, context: 2, id: path, path })],
    { sourceLabel: "repo" },
  );
}

/** Anchor one note to a line of the document's only file. */
function noteAt(
  document: ReviewDocumentV1,
  id: string,
  side: ReviewSide,
  line: number,
  extra: Partial<ReviewStoredNote["note"]> = {},
): ReviewStoredNote {
  const file = document.files[0]!;
  const hunkIndex =
    file.hunks.findIndex((hunk) => {
      const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
      const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
      return line >= start && line < start + Math.max(count, 1);
    }) || 0;
  return {
    note: {
      id,
      source: "agent",
      fileKey: file.key,
      anchor: reviewLineAnchor(file.hunks, { hunkIndex: Math.max(hunkIndex, 0), side, line }),
      summary: `note ${id}`,
      editable: false,
      ...extra,
    },
    resolution: "active",
  };
}

describe("relocateReviewLine", () => {
  test("follows a line pushed down by an insertion above it", () => {
    const previous = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma!",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );
    const next = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma!",
        "one",
        "two",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );

    expect(relocateReviewLine(previous.files[0]!, next.files[0]!, "new", 8)).toEqual({
      line: 10,
      kind: "change",
      previousKind: "change",
    });
  });

  test("prefers the occurrence whose neighbours match when the text repeats", () => {
    const previous = documentOf(
      lines("a", "b", "c", "d", "e", "f", "g", "h"),
      lines("a", "b", "x", "", "c", "d", "e", "y", "", "f", "g", "h"),
    );
    // Insert two lines at the top so both blank lines move down by two.
    const next = documentOf(
      lines("a", "b", "c", "d", "e", "f", "g", "h"),
      lines("p", "q", "a", "b", "x", "", "c", "d", "e", "y", "", "f", "g", "h"),
    );

    // The second blank line (after "y") is at 9 before and 11 after; the nearest blank by
    // number alone would be the first one at 6.
    expect(relocateReviewLine(previous.files[0]!, next.files[0]!, "new", 9)?.line).toBe(11);
  });

  test("reports a changed line that reads as context once its change is staged", () => {
    const previous = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma!",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );
    const next = documentOf(
      lines("alpha", "beta", "gamma!", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"),
      lines(
        "alpha",
        "beta",
        "gamma!",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );

    // "gamma!" was staged: it is now in the index, so the new patch shows no hunk there.
    expect(relocateReviewLine(previous.files[0]!, next.files[0]!, "new", 3)).toBeUndefined();
  });
});

describe("reanchorReviewNotes", () => {
  const previous = documentOf(
    BASE,
    lines("alpha", "beta", "gamma!", "delta", "epsilon", "zeta", "eta", "theta!", "iota", "kappa"),
  );

  test("keeps the same array when no file content changed", () => {
    const notes = [noteAt(previous, "n1", "new", 3)];
    const same = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma!",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );

    expect(reanchorReviewNotes(previous, same, notes)).toBe(notes);
  });

  test("moves a note with the text it was written beside", () => {
    const next = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma!",
        "one",
        "two",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );
    const [moved] = reanchorReviewNotes(previous, next, [noteAt(previous, "n1", "new", 8)]);

    expect(moved?.note.anchor.preferred).toEqual({ side: "new", line: 10 });
    expect(moved?.note.anchor.newRange).toEqual([10, 10]);
    // The insertion's trailing context touches the second change's leading context, so
    // the two changes now share one hunk.
    expect(next.files[0]?.hunks).toHaveLength(1);
    expect(moved?.note.anchor.ownerHunkIndex).toBe(0);
    expect(moved?.resolution).toBe("active");
  });

  test("follows a deleted line by old-side text", () => {
    const withDeletion = documentOf(
      BASE,
      lines("alpha", "beta", "delta", "epsilon", "zeta", "eta", "theta!", "iota", "kappa"),
    );
    const next = documentOf(
      BASE,
      lines("zero", "alpha", "beta", "delta", "epsilon", "zeta", "eta", "theta!", "iota", "kappa"),
    );
    const [moved] = reanchorReviewNotes(withDeletion, next, [noteAt(withDeletion, "n1", "old", 3)]);

    // The old side did not move: "gamma" is still index line 3.
    expect(moved?.note.anchor.preferred).toEqual({ side: "old", line: 3 });
    expect(moved?.note.anchor.ownerHunkIndex).toBe(0);
  });

  test("drops the notes of a staged hunk and keeps the others", () => {
    const next = documentOf(
      lines("alpha", "beta", "gamma!", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"),
      lines(
        "alpha",
        "beta",
        "gamma!",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );
    const result = reanchorReviewNotes(previous, next, [
      noteAt(previous, "staged", "new", 3),
      noteAt(previous, "kept", "new", 8),
    ]);

    expect(result.map((entry) => entry.note.id)).toEqual(["kept"]);
    expect(result[0]?.note.anchor.ownerHunkIndex).toBe(0);
  });

  test("drops a note whose line was rewritten", () => {
    const next = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma?",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );

    expect(reanchorReviewNotes(previous, next, [noteAt(previous, "n1", "new", 3)])).toEqual([]);
  });

  test("drops every note of a file the next document no longer lists", () => {
    const next: ReviewDocumentV1 = { files: [] };

    expect(reanchorReviewNotes(previous, next, [noteAt(previous, "n1", "new", 3)])).toEqual([]);
  });

  test("replies share their root's fate and anchor", () => {
    const root = noteAt(previous, "root", "new", 8);
    const reply: ReviewStoredNote = {
      ...noteAt(previous, "reply", "new", 8, { parentId: "root", source: "user", editable: true }),
    };
    const next = documentOf(
      BASE,
      lines(
        "alpha",
        "beta",
        "gamma!",
        "one",
        "two",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );

    // The reply is listed first, as it would be when replies live in another array.
    const moved = reanchorReviewNotes(previous, next, [reply, root]);
    expect(moved.map((entry) => entry.note.id)).toEqual(["reply", "root"]);
    expect(moved[0]?.note.anchor.preferred).toEqual({ side: "new", line: 10 });

    const staged = documentOf(
      lines("alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta!", "iota", "kappa"),
      lines(
        "alpha",
        "beta",
        "gamma!",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );
    expect(reanchorReviewNotes(previous, staged, [reply, root])).toEqual([]);
  });
});

describe("reanchorReviewSelection", () => {
  test("keeps the selected hunk when a hunk appears above it", () => {
    const previous = documentOf(
      BASE,
      lines("alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta!", "iota", "kappa"),
    );
    const next = documentOf(
      BASE,
      lines(
        "alpha!",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta!",
        "iota",
        "kappa",
      ),
    );
    const fileKey = previous.files[0]!.key;

    expect(reanchorReviewSelection(previous, next, { fileKey, hunkIndex: 0 })).toEqual({
      fileKey,
      hunkIndex: 1,
    });
  });

  test("leaves an unchanged file's selection alone", () => {
    const previous = documentOf(
      BASE,
      lines("alpha", "beta", "gamma!", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"),
    );
    const selection = { fileKey: previous.files[0]!.key, hunkIndex: 0 };

    expect(reanchorReviewSelection(previous, previous, selection)).toBe(selection);
  });
});
