import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collapseHomePath, createReviewFileStore } from "../core/process/reviewFileStore";
import type { VcsCatalog } from "../core/vcs/types";
import { runAddressListCommand } from "./addressCommand";

const HUNK_ID = "0123456789abcdef0123456789abcdef";
const tempDirs: string[] = [];
const emptyCatalog = { adapters: [], defaultAdapterId: "git", reservedIds: new Set() } as unknown as VcsCatalog;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hunk-address-list-")));
  tempDirs.push(repo);
  const reviewFile = join(repo, "review.jsonl");
  const store = createReviewFileStore(reviewFile);
  store.setHunkDecision({
    hunk: {
      id: HUNK_ID,
      repo: collapseHomePath(repo),
      path: "sections/method.tex",
      oldStart: 40,
      newStart: 42,
      lines: [" context", "-old claim", "+we assume the entries are MCAR", " more"],
    },
    state: "rejected",
  });
  store.upsertNotes({
    notes: [
      {
        kind: "note",
        id: "user:1",
        source: "user",
        author: "user",
        summary: "Not justified",
        rationale: "Cite Little & Rubin.",
        editable: true,
        hunk: HUNK_ID,
        side: "new",
        offset: 2,
        length: 1,
        line: 44,
        lineText: "we assume the entries are MCAR",
        createdAt: "2026-09-24T10:00:00.000Z",
      },
      {
        kind: "note",
        id: "mcp:1",
        parentId: "user:1",
        source: "agent",
        author: "sonnet",
        summary: "Reworded.",
        editable: false,
        hunk: HUNK_ID,
        side: "new",
        offset: 2,
        length: 1,
        line: 44,
        lineText: "we assume the entries are MCAR",
        createdAt: "2026-09-24T10:01:00.000Z",
      },
    ],
    hunks: [],
  });
  return { repo, reviewFile };
}

function run(input: { repo: string; reviewFile?: string; json?: boolean; all?: boolean }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runAddressListCommand(
    {
      kind: "address-list",
      repo: input.repo,
      json: input.json ?? false,
      all: input.all ?? false,
      options: input.reviewFile ? { reviewFile: input.reviewFile } : {},
    },
    { cwd: input.repo, vcsCatalog: emptyCatalog, stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("hunk address --list", () => {
  test("prints each rejection with its headline and threaded notes", () => {
    const { repo, reviewFile } = createRepo();
    const result = run({ repo, reviewFile });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "sections/method.tex:42  we assume the entries are MCAR",
        "    [user] Not justified",
        "    Cite Little & Rubin.",
        "    ↳ [sonnet] Reworded.",
        "",
      ].join("\n"),
    );
  });

  test("emits the records as JSON, and reports an empty repository", () => {
    const { repo, reviewFile } = createRepo();
    const json = run({ repo, reviewFile, json: true });
    const parsed = JSON.parse(json.stdout) as { repo: string; rejections: unknown[] };
    expect(parsed.repo).toBe(collapseHomePath(repo));
    expect(parsed.rejections).toHaveLength(1);

    const other = run({ repo: join(repo, "elsewhere"), reviewFile });
    expect(other.stdout).toBe(`Nothing to address in ${collapseHomePath(join(repo, "elsewhere"))}.\n`);
  });

  test("fails without a configured review file", () => {
    const { repo } = createRepo();
    const result = run({ repo });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("review_file");
  });
});
