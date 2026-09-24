import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
import { diffHunkIdentity } from "../core/changeset/hunkDecisions";
import { COMMIT_STATUS_FILE_NAME, createReviewFileStore } from "../core/process/reviewFileStore";
import type { HunkRecord } from "../core/review/reviewFile";
import { resolveTheme } from "./themes";

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

const WIDE = { width: 200, height: 40 };

const BEFORE = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
const AFTER = BEFORE.replace("line 3\n", "first change\n").replace("line 15\n", "second change\n");
const OTHER_BEFORE = lines("alpha", "beta", "gamma");
const OTHER_AFTER = lines("alpha", "other change", "gamma");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RANGE_COMMITS = [
  COMMIT,
  "123456789abcdef0123456789abcdef012345678",
  "23456789abcdef0123456789abcdef0123456789",
];

const tempDirs: string[] = [];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;

function createReviewFile() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-apphost-decisions-"));
  tempDirs.push(dir);
  return join(dir, "review.jsonl");
}

/** The two-file review under test: `sample.ts` has two hunks and `other.ts` one. */
function createFiles() {
  return [
    createTestDiffFile({
      after: AFTER,
      before: BEFORE,
      context: 2,
      id: "sample",
      path: "sample.ts",
    }),
    createTestDiffFile({
      after: OTHER_AFTER,
      before: OTHER_BEFORE,
      context: 1,
      id: "other",
      path: "other.ts",
    }),
  ];
}

function createBootstrap(
  reviewFile: string | undefined,
  { showDecidedHunks, commit = true }: { showDecidedHunks?: boolean; commit?: boolean } = {},
) {
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "changeset:hunk-decisions",
    initialMode: "unified",
    files: createFiles(),
    vcsOptions: {
      ...(reviewFile === undefined ? {} : { reviewFile }),
      ...(showDecidedHunks === undefined ? {} : { showDecidedHunks }),
    },
  });
  return commit
    ? {
        ...bootstrap,
        review: { kind: "commit" as const, provider: "git", title: "Commit", revision: COMMIT },
      }
    : bootstrap;
}

function createRangeBootstrap(reviewFile: string) {
  return {
    ...createBootstrap(reviewFile, { commit: false }),
    review: {
      kind: "comparison" as const,
      provider: "Git",
      title: "Three commits",
      base: `${COMMIT}^`,
      head: RANGE_COMMITS[2]!,
      commitCount: RANGE_COMMITS.length,
      commits: [
        {
          title: "Newest commit",
          revision: RANGE_COMMITS[2]!,
          displayRevision: RANGE_COMMITS[2]!.slice(0, 7),
        },
      ],
    },
    reviewCommitIds: RANGE_COMMITS,
  };
}

function hunkRecords(reviewFile: string): HunkRecord[] {
  return createReviewFileStore(reviewFile)
    .load()
    .records.filter((record): record is HunkRecord => record.kind === "hunk");
}

function commitStatus(reviewFile: string) {
  const path = join(reviewFile, "..", COMMIT_STATUS_FILE_NAME);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Return the rail marker's foreground on the rendered line that carries `text`. */
function railColorOfLine(target: Awaited<ReturnType<typeof testRender>>, text: string) {
  const line = target
    .captureSpans()
    .lines.find((candidate) => candidate.spans.some((span) => span.text.includes(text)));
  const rail = line?.spans.find((span) => span.text.includes("▌"));
  return capturedTestColorToHex(rail?.fg)?.toLowerCase();
}

async function flush(target: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await target.renderOnce();
    await Bun.sleep(0);
    await target.renderOnce();
  });
}

async function pressKeys(target: Awaited<ReturnType<typeof testRender>>, keys: string) {
  for (const key of keys) {
    await act(async () => {
      await target.mockInput.typeText(key);
    });
    await flush(target);
  }
}

afterEach(async () => {
  if (setup) {
    const current = setup;
    setup = undefined;
    await act(async () => {
      current.renderer.destroy();
    });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("AppHost hunk decisions", () => {
  test("+ accepts and hides the selected hunk, V shows it in green, and + again clears it", async () => {
    const reviewFile = createReviewFile();
    setup = await testRender(<AppHost bootstrap={createBootstrap(reviewFile)} />, WIDE);
    await flush(setup);

    let frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).toContain("second change");
    expect(frame).not.toContain("decided");

    await pressKeys(setup, "+");

    frame = setup.captureCharFrame();
    expect(frame).not.toContain("first change");
    expect(frame).toContain("second change");
    expect(frame).toContain("1 decided hunk hidden");
    const sample = createFiles()[0]!;
    expect(hunkRecords(reviewFile)).toEqual([
      {
        kind: "hunk",
        id: diffHunkIdentity(sample, sample.metadata.hunks[0]!),
        repo: expect.any(String),
        path: "sample.ts",
        state: "accepted",
        commits: [COMMIT],
        oldStart: 1,
        newStart: 1,
      },
    ]);
    expect(createReviewFileStore(reviewFile).load().records[0]).toEqual({
      kind: "commit",
      repo: expect.any(String),
      hash: COMMIT,
      hunkCount: 3,
    });
    // Two hunks are still undecided, so the commit has no status yet.
    expect(commitStatus(reviewFile)).toBe("");

    await pressKeys(setup, "V");

    frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).not.toContain("decided");

    // The selection followed the second hunk while the first was hidden; step back onto
    // the accepted one, which the status line then names, and + clears it.
    await pressKeys(setup, "[");
    expect(setup.captureCharFrame()).toContain("selected hunk accepted");
    expect(railColorOfLine(setup, "first change")).toBe(
      resolveTheme("github-dark-default", null).acceptedRailColor.toLowerCase(),
    );
    expect(railColorOfLine(setup, "second change")).not.toBe(
      railColorOfLine(setup, "first change"),
    );

    await pressKeys(setup, "+");

    frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).not.toContain("decided");
    expect(hunkRecords(reviewFile)).toEqual([]);
  });

  test("deciding every hunk derives the commit status, and = moves a rejection to fixed", async () => {
    const reviewFile = createReviewFile();
    setup = await testRender(<AppHost bootstrap={createBootstrap(reviewFile)} />, WIDE);
    await flush(setup);

    // Reject the first hunk (which hides it and selects the second), then accept the rest.
    await pressKeys(setup, "-++");

    let frame = setup.captureCharFrame();
    expect(frame).not.toContain("first change");
    expect(frame).not.toContain("other change");
    expect(frame).toContain("3 decided hunks hidden");
    expect(commitStatus(reviewFile)).toBe(`${COMMIT} reviewed\n`);
    expect(hunkRecords(reviewFile).find((record) => record.state === "rejected")).toBeDefined();
    expect(hunkRecords(reviewFile).filter((record) => record.state === "accepted")).toHaveLength(2);

    // Show the decided hunks, return to the rejected file, and mark its first hunk fixed.
    await pressKeys(setup, "V,");
    frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).toContain("selected hunk rejected");
    expect(railColorOfLine(setup, "first change")).toBe(
      resolveTheme("github-dark-default", null).rejectedRailColor.toLowerCase(),
    );

    await pressKeys(setup, "=");
    const approvedFrame = setup.captureCharFrame();
    expect(approvedFrame).toContain("selected hunk fixed");
    expect(approvedFrame).toContain("✓");
    expect(commitStatus(reviewFile)).toBe(`${COMMIT} approved\n`);
    expect(railColorOfLine(setup, "first change")).toBe(
      resolveTheme("github-dark-default", null).fixedRailColor.toLowerCase(),
    );
    expect(hunkRecords(reviewFile).find((record) => record.state === "fixed")).toBeDefined();
  });

  test("an aggregate range review updates every selected commit", async () => {
    const reviewFile = createReviewFile();
    setup = await testRender(<AppHost bootstrap={createRangeBootstrap(reviewFile)} />, WIDE);
    await flush(setup);

    await pressKeys(setup, "-++V,=");

    expect(commitStatus(reviewFile)).toBe(
      RANGE_COMMITS.toSorted()
        .map((commit) => `${commit} approved\n`)
        .join(""),
    );
    expect(
      hunkRecords(reviewFile).every((record) =>
        RANGE_COMMITS.every((commit) => record.commits?.includes(commit)),
      ),
    ).toBe(true);
  });

  test("= refuses a hunk that is not rejected", async () => {
    const reviewFile = createReviewFile();
    setup = await testRender(<AppHost bootstrap={createBootstrap(reviewFile)} />, WIDE);
    await flush(setup);

    await pressKeys(setup, "=");

    expect(setup.captureCharFrame()).toContain("Only a rejected hunk can be marked fixed");
    expect(hunkRecords(reviewFile)).toEqual([]);
  });

  test("show_decided_hunks starts with decided hunks shown, and V still hides them", async () => {
    const reviewFile = createReviewFile();
    const sample = createFiles()[0]!;
    const hunk = sample.metadata.hunks[0]!;
    createReviewFileStore(reviewFile).setHunkDecision({
      hunk: {
        id: diffHunkIdentity(sample, hunk),
        repo: "~/elsewhere",
        path: "sample.ts",
        oldStart: hunk.deletionStart,
        newStart: hunk.additionStart,
      },
      state: "accepted",
    });
    setup = await testRender(
      <AppHost bootstrap={createBootstrap(reviewFile, { showDecidedHunks: true })} />,
      WIDE,
    );
    await flush(setup);

    let frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).toContain("selected hunk accepted");

    await pressKeys(setup, "V");

    frame = setup.captureCharFrame();
    expect(frame).not.toContain("first change");
    expect(frame).toContain("1 decided hunk hidden");
  });

  test("a decision outside a single-commit review records no commit", async () => {
    const reviewFile = createReviewFile();
    setup = await testRender(
      <AppHost bootstrap={createBootstrap(reviewFile, { commit: false })} />,
      WIDE,
    );
    await flush(setup);

    await pressKeys(setup, "+");

    const { records } = createReviewFileStore(reviewFile).load();
    expect(records.map((record) => record.kind)).toEqual(["hunk"]);
    expect((records[0] as HunkRecord).commits).toBeUndefined();
  });

  test("without a configured file, + explains how to enable decisions", async () => {
    setup = await testRender(<AppHost bootstrap={createBootstrap(undefined)} />, WIDE);
    await flush(setup);

    await pressKeys(setup, "+");

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Set review_file");
    expect(frame).toContain("first change");
  });
});
