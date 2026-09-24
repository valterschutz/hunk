import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { HunkRecord, NoteRecord } from "../review/reviewFile";
import {
  COMMIT_STATUS_FILE_NAME,
  collapseHomePath,
  createReviewFileStore,
  expandReviewFilePath,
} from "./reviewFileStore";

const tempDirs: string[] = [];

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-review-file-"));
  tempDirs.push(dir);
  return join(dir, "nested", "review.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const HUNK = {
  id: "0123456789abcdef0123456789abcdef",
  repo: "~/repo",
  path: "a.txt",
  commit: "abc",
  oldStart: 1,
  newStart: 1,
  lines: [" ctx", "-old", "+new"],
};
const COMMIT = { hash: "abc", hunkCount: 1 };

function note(id: string, overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    kind: "note",
    id,
    source: "user",
    summary: "objection",
    editable: true,
    hunk: HUNK.id,
    side: "new",
    offset: 2,
    length: 1,
    line: 3,
    lineText: "new",
    createdAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

function statusFile(path: string) {
  return join(path, "..", COMMIT_STATUS_FILE_NAME);
}

describe("createReviewFileStore", () => {
  test("an unconfigured store is disabled, empty, and refuses to write", () => {
    for (const configured of [undefined, ""]) {
      const store = createReviewFileStore(configured);
      expect(store.enabled).toBe(false);
      expect(store.load()).toEqual({ records: [], warnings: [] });
      expect(() =>
        store.setHunkDecision({ hunk: HUNK, state: "accepted", commit: COMMIT }),
      ).toThrow(/review_file/);
    }
  });

  test("a decision creates the file and the commit status beside it", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    expect(store.load().records).toEqual([]);

    store.setHunkDecision({ hunk: HUNK, state: "rejected", commit: COMMIT });

    expect(store.load().records).toEqual([
      { kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 1 },
      { kind: "hunk", ...HUNK, state: "rejected" },
    ]);
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc verified\n");
    expect(existsSync(`${path}.tmp`)).toBe(false);

    store.setHunkDecision({ hunk: HUNK, state: "addressed", commit: COMMIT });
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc addressed\n");
  });

  test("an accepted hunk keeps no text, and clearing the decision drops the record", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);

    store.setHunkDecision({ hunk: HUNK, state: "accepted", commit: COMMIT });
    const [, accepted] = store.load().records;
    expect(accepted).toEqual({ kind: "hunk", ...HUNK, lines: undefined, state: "accepted" });
    expect("lines" in (accepted as HunkRecord)).toBe(false);
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc addressed\n");

    store.setHunkDecision({ hunk: HUNK, state: undefined, commit: COMMIT });
    expect(store.load().records).toEqual([
      { kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 1 },
    ]);
    expect(readFileSync(statusFile(path), "utf8")).toBe("");
  });

  test("notes keep their hunk record alive without a decision and are pruned together", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);

    expect(
      store.upsertNotes({ notes: [note("user:1")], hunks: [{ kind: "hunk", ...HUNK }] }),
    ).toBe(true);
    const { lines: _lines, commit: _commit, ...hunkWithoutLines } = HUNK;
    expect(store.load().records).toEqual([
      { kind: "hunk", ...hunkWithoutLines, commit: "abc" },
      note("user:1"),
    ]);
    expect(
      store.upsertNotes({ notes: [note("user:1")], hunks: [{ kind: "hunk", ...HUNK }] }),
    ).toBe(false);

    store.upsertNotes({
      notes: [note("user:1", { summary: "edited" }), note("mcp:reply", { parentId: "user:1" })],
      hunks: [{ kind: "hunk", ...HUNK }],
    });
    // Equal timestamps sort by id, so the agent reply precedes the reviewer's note.
    expect(
      store.load().records.map((record) => (record.kind === "note" ? record.summary : "")),
    ).toEqual(["", "objection", "edited"]);

    store.setHunkDecision({ hunk: HUNK, state: "rejected" });
    store.setHunkDecision({ hunk: HUNK, state: undefined });
    expect(store.load().records.some((record) => record.kind === "hunk")).toBe(true);

    expect(store.removeNotes(["user:1", "mcp:reply"])).toBe(true);
    expect(store.load().records).toEqual([]);
    expect(store.removeNotes(["user:1"])).toBe(false);
  });

  test("keeps records another writer added since the last load", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    store.setHunkDecision({ hunk: HUNK, state: "rejected", commit: COMMIT });

    const synced: HunkRecord = {
      kind: "hunk",
      id: "fedcba9876543210fedcba9876543210",
      repo: "~/repo",
      path: "b.txt",
      state: "accepted",
      oldStart: 5,
      newStart: 5,
    };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(synced)}\n`);

    store.upsertNotes({ notes: [note("user:1")], hunks: [] });
    expect(store.load().records).toContainEqual(synced);
  });

  test("reports a malformed line, keeps it on write, and still serves the rest", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    store.setHunkDecision({ hunk: HUNK, state: "rejected", commit: COMMIT });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"hunk","id":"bad"}\nnot json\n`);

    const loaded = store.load();
    expect(loaded.records).toHaveLength(2);
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toMatch(/:3: .*not a hunk identity/);

    store.setHunkDecision({ hunk: HUNK, state: "accepted", commit: COMMIT });
    const text = readFileSync(path, "utf8");
    expect(text).toContain('{"kind":"hunk","id":"bad"}\n');
    expect(text.endsWith("not json\n")).toBe(true);
  });

  test("expands ~ in the configured path", () => {
    const home = homedir();
    const path = tempPath();
    const inHome = relative(home, path);
    if (inHome.startsWith("..")) {
      return;
    }
    const store = createReviewFileStore(`~/${inHome}`);
    expect(store.path).toBe(path);
    expect(expandReviewFilePath("~")).toBe(home);
    expect(collapseHomePath(path)).toBe(`~/${inHome}`);
  });

  test("collapses paths under the home directory and leaves others alone", () => {
    expect(collapseHomePath(homedir())).toBe("~");
    expect(collapseHomePath("/definitely/elsewhere")).toBe("/definitely/elsewhere");
  });
});
