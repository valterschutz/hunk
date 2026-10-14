import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
import { loadAppBootstrap } from "../core/changeset/loaders";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { resolveTheme } from "./themes";

setDefaultTimeout(15_000);

const tempDirs: string[] = [];
const numberedLines = (count: number) =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

/** Run one fixture Git command and return its text output. */
function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** Create a committed file with two separate edits, the first one already staged. */
function createPartlyStagedRepo() {
  const repo = mkdtempSync(join(tmpdir(), "hunk-staging-"));
  tempDirs.push(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "file.txt"), numberedLines(20));
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "base");
  writeFileSync(join(repo, "file.txt"), numberedLines(20).replace("line 3\n", "line three\n"));
  git(repo, "add", "file.txt");
  writeFileSync(
    join(repo, "file.txt"),
    numberedLines(20).replace("line 3\n", "line three\n").replace("line 17\n", "line seventeen\n"),
  );
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

/** Return the rail marker's foreground on the rendered line that ends with `text`. */
function railColorOfLine(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const line = setup.captureSpans().lines.find((candidate) =>
    candidate.spans
      .map((span) => span.text)
      .join("")
      .trimEnd()
      .endsWith(text),
  );
  const rail = line?.spans.find((span) => span.text.includes("▌"));
  return capturedTestColorToHex(rail?.fg)?.toLowerCase();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTestDirectory(dir)));
});

describe("staging the selected hunk", () => {
  test("shows staged and unstaged hunks together and toggles the selected one with Space", async () => {
    const repo = createPartlyStagedRepo();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified" } },
      { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
    );
    const theme = resolveTheme(bootstrap.initialTheme ?? "github-dark-default", null);
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 160, height: 40 });

    try {
      await waitForFrame(
        setup,
        (frame) => frame.includes("line three") && frame.includes("line seventeen"),
      );
      // The staged first hunk is selected, so its rail is at full strength. Context rows show the
      // mark against a plain rail that differs from it in every theme.
      expect(railColorOfLine(setup, "line 2")).toBe(theme.stagedRailColor.toLowerCase());

      await act(async () => setup.mockInput.typeText(" "));
      await waitForFrame(setup, () => !git(repo, "diff", "--cached").includes("line three"));
      expect(git(repo, "diff")).toContain("+line three");
      await waitForFrame(
        setup,
        () => railColorOfLine(setup, "line 2") === theme.contextRailColor.toLowerCase(),
      );

      await act(async () => setup.mockInput.typeText("]"));
      await act(async () => setup.mockInput.typeText(" "));
      await waitForFrame(setup, () => git(repo, "diff", "--cached").includes("line seventeen"));
      expect(git(repo, "diff", "--cached")).not.toContain("line three");
      await waitForFrame(
        setup,
        () => railColorOfLine(setup, "line 16") === theme.stagedRailColor.toLowerCase(),
      );
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("reports that a revision review has nothing to stage", async () => {
    const repo = createPartlyStagedRepo();
    const bootstrap = await loadAppBootstrap(
      { kind: "show", options: { mode: "unified" } },
      { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 160, height: 40 });

    try {
      await waitForFrame(setup, (frame) => frame.includes("line 20"));
      await act(async () => setup.mockInput.typeText(" "));
      await waitForFrame(setup, (frame) => frame.includes("Nothing to stage in this review"));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
