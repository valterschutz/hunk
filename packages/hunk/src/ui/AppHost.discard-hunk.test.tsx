import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";
import { loadAppBootstrap } from "../core/changeset/loaders";
import { getBundledVcsCatalog } from "../app/vcsCatalog";

setDefaultTimeout(15_000);

const tempDirs: string[] = [];
const numberedLines = (count: number) =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

/** Run one fixture Git command and return its text output. */
function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** Create two independently discardable edits, optionally staged. */
function createChangedRepo(staged: boolean) {
  const repo = mkdtempSync(join(tmpdir(), "hunk-discard-selected-"));
  tempDirs.push(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "file.txt"), numberedLines(20));
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "base");
  writeFileSync(
    join(repo, "file.txt"),
    numberedLines(20).replace("line 3\n", "line three\n").replace("line 17\n", "line seventeen\n"),
  );
  if (staged) git(repo, "add", "file.txt");
  return repo;
}

/** Create one standard hunk containing two adjacent changed rows. */
function createAdjacentChangedRepo() {
  const repo = mkdtempSync(join(tmpdir(), "hunk-discard-line-"));
  tempDirs.push(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "file.txt"), "before\nold one\nold two\nafter\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "base");
  writeFileSync(join(repo, "file.txt"), "before\nnew one\nnew two\nafter\n");
  return repo;
}

/** Render until one visible condition holds. */
async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
    });
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for frame:\n${frame}`);
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTestDirectory(dir)));
});

describe("discarding the selected current-change hunk", () => {
  test("line mode discards only the selected changed row", async () => {
    const repo = createAdjacentChangedRepo();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified" } },
      { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 160,
      height: 30,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("new two"));
      await act(async () => setup.mockInput.typeText("H"));
      await waitForFrame(setup, (frame) => frame.includes("Line review mode"));
      await act(async () => setup.mockInput.typeText("]"));
      await act(async () => setup.mockInput.typeText("d"));
      await waitForFrame(setup, (frame) => frame.includes("Discard selected line?"));
      await act(async () => setup.mockInput.typeText("y"));
      await waitForFrame(setup, (frame) => !frame.includes("Discard selected line?"));

      expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe(
        "before\nnew one\nold two\nafter\n",
      );
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  for (const staged of [false, true]) {
    test(`discards one ${staged ? "staged" : "unstaged"} hunk with d`, async () => {
      const repo = createChangedRepo(staged);
      const bootstrap = await loadAppBootstrap(
        { kind: "vcs", staged, options: { mode: "unified" } },
        { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
      );
      const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
        width: 160,
        height: 30,
      });

      try {
        await waitForFrame(setup, (frame) => frame.includes("line three"));
        await act(async () => setup.mockInput.typeText("d"));
        let frame = await waitForFrame(setup, (value) => value.includes("Discard selected hunk?"));
        if (staged) {
          expect(frame).toContain("Your working tree is");
          expect(frame).toContain("unchanged.");
        } else {
          expect(frame).toContain("cannot be undone");
        }

        await act(async () => setup.mockInput.typeText("y"));
        frame = await waitForFrame(
          setup,
          (value) => !value.includes("Discard selected hunk?") && !value.includes("line three"),
        );
        expect(frame).toContain("line seventeen");

        const workingTree = readFileSync(join(repo, "file.txt"), "utf8");
        if (staged) {
          expect(workingTree).toContain("line three");
          expect(git(repo, "diff", "--cached")).not.toContain("line three");
          expect(git(repo, "diff")).toContain("line three");
        } else {
          expect(workingTree).toContain("line 3\n");
          expect(workingTree).not.toContain("line three");
        }
      } finally {
        await act(async () => setup.renderer.destroy());
      }
    });
  }
});
