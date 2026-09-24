import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import { reduceReviewState } from "./reducer";
import { createInitialReviewState, type ReviewStoredNote } from "./state";

function note(
  id: string,
  source: "user" | "agent",
  fileKey: string,
  hunks: never[],
): ReviewStoredNote {
  return {
    note: {
      id,
      source,
      fileKey,
      anchor: reviewLineAnchor(hunks, { hunkIndex: 0, side: "new", line: 1 }),
      summary: id,
      editable: source === "user",
    },
    resolution: "active",
  };
}

describe("notes/restore", () => {
  test("appends restored notes by source and skips ids the state already holds", () => {
    const document = projectReviewDocument([createTestDiffFile()]);
    const file = document.files[0]!;
    const hunks = file.hunks as never[];
    const initial = createInitialReviewState(document);
    const existing = note("user:1", "user", file.key, hunks);
    const withExisting = { ...initial, userNotes: [existing] };

    const next = reduceReviewState(withExisting, {
      type: "notes/restore",
      notes: [
        note("user:1", "user", file.key, hunks),
        note("user:2", "user", file.key, hunks),
        note("mcp:1", "agent", file.key, hunks),
      ],
    });

    expect(next.userNotes.map((entry) => entry.note.id)).toEqual(["user:1", "user:2"]);
    expect(next.userNotes[0]).toBe(existing);
    expect(next.liveNotes.map((entry) => entry.note.id)).toEqual(["mcp:1"]);

    const unchanged = reduceReviewState(next, { type: "notes/restore", notes: [existing] });
    expect(unchanged).toBe(next);
  });
});
