import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import { reviewHunkIdentity } from "./hunkIdentity";
import {
  commitStatuses,
  migrateLegacyRecords,
  parseReviewRecord,
  persistableNoteRecords,
  restoreNoteRecords,
  serializeCommitStatuses,
  serializeReviewRecords,
  type HunkRecord,
  type NoteRecord,
  type ReviewRecord,
} from "./reviewFile";
import type { ReviewStoredNote } from "./state";
import type { ReviewNoteV1 } from "./types";

const BEFORE = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
const AFTER = BEFORE.replace("line 3\n", "first change\n").replace("line 15\n", "second change\n");

function document(before = BEFORE, after = AFTER) {
  const file = createTestDiffFile({ after, before, context: 2, id: "sample", path: "sample.ts" });
  return projectReviewDocument([file], { sourceLabel: "repo" });
}

function storedNote(
  doc: ReturnType<typeof document>,
  overrides: Partial<ReviewNoteV1> & { hunkIndex: number; side: "old" | "new"; line: number },
): ReviewStoredNote {
  const file = doc.files[0]!;
  const { hunkIndex, side, line, ...note } = overrides;
  return {
    note: {
      id: "user:1",
      source: "user",
      fileKey: file.key,
      anchor: reviewLineAnchor(file.hunks, { hunkIndex, side, line }),
      summary: "summary",
      author: "user",
      createdAt: "2026-09-24T10:00:00.000Z",
      editable: true,
      ...note,
    },
    resolution: "active",
  };
}

const HUNK: HunkRecord = {
  kind: "hunk",
  id: "0123456789abcdef0123456789abcdef",
  repo: "~/repo",
  path: "a.txt",
  state: "rejected",
  oldStart: 1,
  newStart: 1,
};

const OTHER_ID = "fedcba9876543210fedcba9876543210";

describe("review records", () => {
  test("migrates the legacy addressed decision", () => {
    const parsed = parseReviewRecord(JSON.stringify({ ...HUNK, state: "addressed" }));

    expect(parsed).toEqual([{ ...HUNK, state: "fixed" }]);
  });

  test("round-trip through JSON Lines, sorted by kind and key", () => {
    const note: NoteRecord = {
      kind: "note",
      id: "user:2",
      source: "user",
      summary: "later",
      editable: true,
      hunk: HUNK.id,
      side: "new",
      offset: 1,
      length: 1,
      line: 2,
      lineText: "new",
      createdAt: "2026-09-24T10:00:01.000Z",
    };
    const earlier: NoteRecord = { ...note, id: "user:1", createdAt: "2026-09-24T10:00:00.000Z" };
    const review: ReviewRecord = {
      kind: "review",
      repo: "~/repo",
      commits: ["abc", "def"],
      hunks: [HUNK.id, OTHER_ID],
    };

    const text = serializeReviewRecords([note, HUNK, earlier, review]);
    const parsed = text.trimEnd().split("\n").flatMap(parseReviewRecord);

    expect(parsed).toEqual([review, HUNK, earlier, note]);
    expect(serializeReviewRecords(parsed as ReviewRecord[])).toBe(text);
  });

  test("rejects malformed records with a reason", () => {
    expect(() => parseReviewRecord("nope")).toThrow(/not JSON/);
    expect(() => parseReviewRecord('{"kind":"other"}')).toThrow(/kind "other" is unknown/);
    expect(() => parseReviewRecord('{"kind":"hunk","id":"x"}')).toThrow(/not a hunk identity/);
    expect(() => parseReviewRecord(JSON.stringify({ ...HUNK, state: "maybe" }))).toThrow(
      /is not a decision/,
    );
    expect(() => parseReviewRecord('{"kind":"commit","repo":"r","hash":"h"}')).toThrow(/hunkCount/);
    expect(() => parseReviewRecord('{"kind":"review","repo":"r","commits":[],"hunks":[]}')).toThrow(
      /at least one commit/,
    );
    expect(() =>
      parseReviewRecord('{"kind":"review","repo":"r","commits":["a"],"hunks":["x"]}'),
    ).toThrow(/not a hunk identity/);
  });
});

describe("migrateLegacyRecords", () => {
  const legacy = (line: object) => parseReviewRecord(JSON.stringify(line));

  test("turns a completely decided legacy commit into a review of its decided hunks", () => {
    const parsed = [
      ...legacy({ kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 2 }),
      ...legacy({ ...HUNK, commit: "abc" }),
      ...legacy({ ...HUNK, id: OTHER_ID, state: "accepted", commits: ["abc", "def"] }),
    ];

    expect(migrateLegacyRecords(parsed)).toEqual([
      { kind: "review", repo: "~/repo", commits: ["abc"], hunks: [HUNK.id, OTHER_ID] },
      HUNK,
      { ...HUNK, id: OTHER_ID, state: "accepted" },
    ]);
  });

  test("drops a legacy commit whose attributed decisions fall short", () => {
    const parsed = [
      ...legacy({ kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 2 }),
      ...legacy({ ...HUNK, commits: ["abc"] }),
    ];

    expect(migrateLegacyRecords(parsed)).toEqual([HUNK]);
  });
});

describe("commitStatuses", () => {
  const review: ReviewRecord = {
    kind: "review",
    repo: "~/repo",
    commits: ["abc"],
    hunks: [HUNK.id, OTHER_ID],
  };
  const other: HunkRecord = { ...HUNK, id: OTHER_ID, state: "accepted" };

  test("leaves a commit with undecided hunks without a status", () => {
    expect(commitStatuses([review, other]).size).toBe(0);
  });

  test("is reviewed while a rejection is open, and approved once none is", () => {
    expect(commitStatuses([review, HUNK, other]).get("abc")).toBe("reviewed");
    expect(commitStatuses([review, { ...HUNK, state: "fixed" }, other]).get("abc")).toBe(
      "approved",
    );
    expect(commitStatuses([review, { ...HUNK, state: "accepted" }, other]).get("abc")).toBe(
      "approved",
    );
  });

  test("gives every commit in a comparison the aggregate review status", () => {
    const range: ReviewRecord = { ...review, commits: ["abc", "def"] };

    expect(commitStatuses([range, HUNK, other])).toEqual(
      new Map([
        ["abc", "reviewed"],
        ["def", "reviewed"],
      ]),
    );
  });

  test("counts a decision on the same hunk content made in any review", () => {
    // The decisions carry no commit: they could come from the working tree before committing.
    expect(commitStatuses([review, { ...HUNK, state: "accepted" }, other]).get("abc")).toBe(
      "approved",
    );
  });

  test("keeps the best status of every review that covers a commit", () => {
    const alone: ReviewRecord = { ...review, hunks: [OTHER_ID] };
    const range: ReviewRecord = { ...review, commits: ["abc", "def"] };

    expect(commitStatuses([alone, range, other])).toEqual(new Map([["abc", "approved"]]));
    expect(commitStatuses([alone, range, HUNK, other])).toEqual(
      new Map([
        ["abc", "approved"],
        ["def", "reviewed"],
      ]),
    );
  });

  test("gives a review without hunks no status", () => {
    expect(commitStatuses([{ ...review, hunks: [] }]).size).toBe(0);
  });

  test("renders the status file sorted by hash", () => {
    expect(
      serializeCommitStatuses(
        new Map([
          ["bbb", "reviewed"],
          ["aaa", "approved"],
        ]),
      ),
    ).toBe("aaa approved\nbbb reviewed\n");
    expect(serializeCommitStatuses(new Map())).toBe("");
  });
});

describe("persistableNoteRecords", () => {
  test("records user-rooted threads with their hunk, offsets, and line text", () => {
    const doc = document();
    const file = doc.files[0]!;
    const second = file.hunks[1]!;
    const root = storedNote(doc, { hunkIndex: 1, side: "new", line: second.additionStart + 2 });
    const reply = storedNote(doc, {
      id: "mcp:reply",
      parentId: "user:1",
      source: "agent",
      author: "sonnet",
      summary: "reply",
      hunkIndex: 1,
      side: "new",
      line: second.additionStart + 2,
    });
    const agentRoot = storedNote(doc, {
      id: "mcp:root",
      source: "agent",
      hunkIndex: 0,
      side: "new",
      line: file.hunks[0]!.additionStart,
    });

    const { notes, hunks } = persistableNoteRecords(doc, [agentRoot, root, reply], {
      repo: "~/repo",
    });

    const identity = reviewHunkIdentity(file, second);
    expect(hunks).toEqual([
      {
        kind: "hunk",
        id: identity,
        repo: "~/repo",
        path: "sample.ts",
        oldStart: second.deletionStart,
        newStart: second.additionStart,
      },
    ]);
    expect(notes.map((note) => note.id)).toEqual(["user:1", "mcp:reply"]);
    expect(notes[0]).toMatchObject({
      hunk: identity,
      side: "new",
      offset: 2,
      length: 1,
      line: second.additionStart + 2,
      lineText: "second change",
      author: "user",
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    expect(notes[1]).toMatchObject({ parentId: "user:1", source: "agent", hunk: identity });
  });

  test("anchors an old-side note by its deletion row", () => {
    const doc = document();
    const first = doc.files[0]!.hunks[0]!;
    const note = storedNote(doc, { hunkIndex: 0, side: "old", line: first.deletionStart + 2 });

    const { notes } = persistableNoteRecords(doc, [note], { repo: "~/repo" });

    expect(notes[0]).toMatchObject({ side: "old", offset: 2, lineText: "line 3" });
  });
});

describe("restoreNoteRecords", () => {
  test("rebuilds the notes at the hunk's current lines and skips ids already present", () => {
    const doc = document();
    const second = doc.files[0]!.hunks[1]!;
    const root = storedNote(doc, { hunkIndex: 1, side: "new", line: second.additionStart + 2 });
    const reply = storedNote(doc, {
      id: "mcp:reply",
      parentId: "user:1",
      source: "agent",
      hunkIndex: 1,
      side: "new",
      line: second.additionStart + 2,
    });
    const records = persistableNoteRecords(doc, [root, reply], { repo: "~/repo" });
    const all: ReviewRecord[] = [...records.hunks, ...records.notes];

    // Ten lines inserted above shift the hunk without changing its content.
    const shifted = document(
      lines(...Array.from({ length: 10 }, (_, index) => `intro ${index}`)) + BEFORE,
      lines(...Array.from({ length: 10 }, (_, index) => `intro ${index}`)) + AFTER,
    );
    const restored = restoreNoteRecords(shifted, all, new Set());
    const shiftedSecond = shifted.files[0]!.hunks[1]!;

    expect(restored.map((entry) => entry.note.id)).toEqual(["user:1", "mcp:reply"]);
    expect(restored[0]!.note.anchor.preferred).toEqual({
      side: "new",
      line: shiftedSecond.additionStart + 2,
    });
    expect(restored[0]!.note.anchor.ownerHunkIndex).toBe(1);
    expect(restored[0]!.note.fileKey).toBe(shifted.files[0]!.key);
    expect(restored[1]!.note.anchor).toEqual(restored[0]!.note.anchor);

    expect(restoreNoteRecords(shifted, all, new Set(["user:1", "mcp:reply"]))).toEqual([]);
    expect(restoreNoteRecords(shifted, all, new Set(["user:1"])).map((e) => e.note.id)).toEqual([
      "mcp:reply",
    ]);
  });

  test("leaves notes whose hunk is absent or whose parent is unknown", () => {
    const doc = document();
    const second = doc.files[0]!.hunks[1]!;
    const root = storedNote(doc, { hunkIndex: 1, side: "new", line: second.additionStart + 2 });
    const records = persistableNoteRecords(doc, [root], { repo: "~/repo" });
    const edited = document(BEFORE, AFTER.replace("second change", "different change"));

    expect(restoreNoteRecords(edited, [...records.hunks, ...records.notes], new Set())).toEqual([]);
    const orphanReply: NoteRecord = { ...records.notes[0]!, id: "user:9", parentId: "missing" };
    expect(restoreNoteRecords(doc, [orphanReply], new Set())).toEqual([]);
  });
});
