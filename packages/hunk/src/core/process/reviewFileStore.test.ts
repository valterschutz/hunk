import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  oldStart: 1,
  newStart: 1,
};
const REVIEW = { repo: "~/repo", commits: ["abc"], hunks: [HUNK.id] };

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
      expect(() => store.setHunkDecision({ hunk: HUNK, state: "accepted" })).toThrow(/review_file/);
      expect(() => store.recordReview(REVIEW)).toThrow(/review_file/);
    }
  });

  test("a decision creates the file and the commit status beside it", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    expect(store.load().records).toEqual([]);

    store.recordReview(REVIEW);
    expect(readFileSync(statusFile(path), "utf8")).toBe("");
    store.setHunkDecision({ hunk: HUNK, state: "rejected" });

    expect(store.load().records).toEqual([
      { kind: "review", ...REVIEW },
      { kind: "hunk", ...HUNK, state: "rejected" },
    ]);
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc reviewed\n");
    expect(existsSync(`${path}.tmp`)).toBe(false);

    store.setHunkDecision({ hunk: HUNK, state: "fixed" });
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc approved\n");
  });

  test("a review opened over already decided hunks is approved at once", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    store.setHunkDecision({ hunk: HUNK, state: "accepted" });
    expect(readFileSync(statusFile(path), "utf8")).toBe("");

    store.recordReview({ ...REVIEW, commits: ["ghi", "abc", "def"] });

    expect(readFileSync(statusFile(path), "utf8")).toBe(
      "abc approved\ndef approved\nghi approved\n",
    );
  });

  test("reopening the same commits replaces their review, other reviews stay", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    const other = "fedcba9876543210fedcba9876543210";
    store.recordReview({ ...REVIEW, commits: ["abc", "def"] });
    store.recordReview({ ...REVIEW, commits: ["def", "abc"], hunks: [other, HUNK.id] });
    store.recordReview(REVIEW);

    expect(store.load().records).toEqual([
      { kind: "review", ...REVIEW },
      { kind: "review", repo: "~/repo", commits: ["abc", "def"], hunks: [HUNK.id, other] },
    ]);
  });

  test("migrates legacy commit records when it next writes", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      [
        { kind: "commit", repo: "~/repo", hash: "abc", hunkCount: 1 },
        { kind: "commit", repo: "~/repo", hash: "def", hunkCount: 2 },
        { kind: "hunk", ...HUNK, state: "accepted", commits: ["abc", "def"] },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    store.upsertNotes({ notes: [], hunks: [] });

    expect(readFileSync(path, "utf8")).not.toContain('"kind":"commit"');
    expect(store.load().records).toEqual([
      { kind: "review", ...REVIEW },
      { kind: "hunk", ...HUNK, state: "accepted" },
    ]);
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc approved\n");
  });

  test("an accepted hunk keeps no text, and clearing the decision drops the record", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);
    store.recordReview(REVIEW);

    store.setHunkDecision({ hunk: HUNK, state: "accepted" });
    const [, accepted] = store.load().records;
    expect(accepted).toEqual({ kind: "hunk", ...HUNK, state: "accepted" });
    expect("lines" in (accepted as HunkRecord)).toBe(false);
    expect(readFileSync(statusFile(path), "utf8")).toBe("abc approved\n");

    store.setHunkDecision({ hunk: HUNK, state: undefined });
    expect(store.load().records).toEqual([{ kind: "review", ...REVIEW }]);
    expect(readFileSync(statusFile(path), "utf8")).toBe("");
  });

  test("notes keep their hunk record alive without a decision and are pruned together", () => {
    const path = tempPath();
    const store = createReviewFileStore(path);

    expect(store.upsertNotes({ notes: [note("user:1")], hunks: [{ kind: "hunk", ...HUNK }] })).toBe(
      true,
    );
    expect(store.load().records).toEqual([{ kind: "hunk", ...HUNK }, note("user:1")]);
    expect(store.upsertNotes({ notes: [note("user:1")], hunks: [{ kind: "hunk", ...HUNK }] })).toBe(
      false,
    );

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
    store.setHunkDecision({ hunk: HUNK, state: "rejected" });

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
    store.setHunkDecision({ hunk: HUNK, state: "rejected" });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"hunk","id":"bad"}\nnot json\n`);

    const loaded = store.load();
    expect(loaded.records).toHaveLength(1);
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toMatch(/:2: .*not a hunk identity/);

    store.setHunkDecision({ hunk: HUNK, state: "accepted" });
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
