import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { reviewLineAnchor } from "./anchors";
import { projectReviewDocument } from "./document";
import { reviewHunkIdentity } from "./hunkIdentity";
import {
  commitStatuses,
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
  commit: "abc",
  oldStart: 1,
  newStart: 1,
  lines: [" ctx", "-old", "+new"],
};

describe("review records", () => {
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
    const commit: ReviewRecord = { kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 1 };

    const text = serializeReviewRecords([note, HUNK, earlier, commit]);
    const parsed = text.trimEnd().split("\n").map(parseReviewRecord);

    expect(parsed).toEqual([commit, HUNK, earlier, note]);
    expect(serializeReviewRecords(parsed)).toBe(text);
  });

  test("rejects malformed records with a reason", () => {
    expect(() => parseReviewRecord("nope")).toThrow(/not JSON/);
    expect(() => parseReviewRecord('{"kind":"other"}')).toThrow(/kind "other" is unknown/);
    expect(() => parseReviewRecord('{"kind":"hunk","id":"x"}')).toThrow(/not a hunk identity/);
    expect(() =>
      parseReviewRecord(JSON.stringify({ ...HUNK, state: "maybe" })),
    ).toThrow(/is not a decision/);
    expect(() => parseReviewRecord('{"kind":"commit","repo":"r","hash":"h"}')).toThrow(
      /hunkCount/,
    );
  });
});

describe("commitStatuses", () => {
  const commit: ReviewRecord = { kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 2 };
  const other: HunkRecord = { ...HUNK, id: "fedcba9876543210fedcba9876543210", state: "accepted" };

  test("leaves a commit with undecided hunks without a status", () => {
    expect(commitStatuses([commit, other]).size).toBe(0);
  });

  test("is verified while a rejection is open, and addressed once none is", () => {
    expect(commitStatuses([commit, HUNK, other]).get("abc")).toBe("verified");
    expect(commitStatuses([commit, { ...HUNK, state: "addressed" }, other]).get("abc")).toBe(
      "addressed",
    );
    expect(commitStatuses([commit, { ...HUNK, state: "accepted" }, other]).get("abc")).toBe(
      "addressed",
    );
  });

  test("ignores decisions made outside a single-commit review", () => {
    const { commit: _commit, ...uncommitted } = HUNK;
    expect(commitStatuses([commit, uncommitted, other]).size).toBe(0);
  });

  test("renders the status file sorted by hash", () => {
    expect(
      serializeCommitStatuses(
        new Map([
          ["bbb", "verified"],
          ["aaa", "addressed"],
        ]),
      ),
    ).toBe("aaa addressed\nbbb verified\n");
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
      commit: "abc",
    });

    const identity = reviewHunkIdentity(file, second);
    expect(hunks).toEqual([
      {
        kind: "hunk",
        id: identity,
        repo: "~/repo",
        path: "sample.ts",
        commit: "abc",
        oldStart: second.deletionStart,
        newStart: second.additionStart,
        lines: [" line 13", " line 14", "-line 15", "+second change", " line 16", " line 17"],
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

    expect(restoreNoteRecords(edited, [...records.hunks, ...records.notes], new Set())).toEqual(
      [],
    );
    const orphanReply: NoteRecord = { ...records.notes[0]!, id: "user:9", parentId: "missing" };
    expect(restoreNoteRecords(doc, [orphanReply], new Set())).toEqual([]);
  });
});
