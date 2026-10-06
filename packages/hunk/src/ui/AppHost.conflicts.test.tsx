import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
import { buildConflictedDiffFile } from "../core/vcs/conflicts";
import { resolveTheme } from "./themes";

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

const WIDE = { width: 200, height: 40 };

const CONFLICTED = [
  "alpha",
  "<<<<<<< HEAD",
  "main line",
  "||||||| parent",
  "base line",
  "=======",
  "feature line",
  ">>>>>>> feat",
  "omega",
  "",
].join("\n");

const tempDirs: string[] = [];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;

/** A repository root holding one conflicted file, plus the diff file Hunk builds for it. */
function createConflictedRepo(contents = CONFLICTED) {
  const dir = mkdtempSync(join(tmpdir(), "hunk-apphost-conflicts-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "f.txt"), contents);
  return { dir, file: buildConflictedDiffFile(dir, { path: "f.txt" }, 0, dir) };
}

function createBootstrap(dir: string, file: ReturnType<typeof buildConflictedDiffFile>) {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:conflicts",
    initialMode: "unified",
    files: [file],
    sourceLabel: dir,
  });
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

async function pressKey(target: Awaited<ReturnType<typeof testRender>>, key: string) {
  await act(async () => {
    await target.mockInput.typeText(key);
  });
  await flush(target);
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

describe("AppHost conflicts", () => {
  test("a conflict shows ours against theirs on a conflict-colored rail", async () => {
    const { dir, file } = createConflictedRepo();
    setup = await testRender(<AppHost bootstrap={createBootstrap(dir, file)} />, WIDE);
    await flush(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("main line");
    expect(frame).toContain("feature line");
    expect(frame).not.toContain("<<<<<<<");
    expect(frame).toContain("(conflict)");
    const theme = resolveTheme("github-dark-default", null);
    expect(railColorOfLine(setup, "main line")).toBe(theme.conflictRailColor.toLowerCase());
  });

  test("> keeps their side, < ours, | both, and B the base", async () => {
    const cases: Array<[string, string]> = [
      [">", "alpha\nfeature line\nomega\n"],
      ["<", "alpha\nmain line\nomega\n"],
      ["|", "alpha\nmain line\nfeature line\nomega\n"],
      ["B", "alpha\nbase line\nomega\n"],
    ];
    for (const [key, expected] of cases) {
      const { dir, file } = createConflictedRepo();
      setup = await testRender(<AppHost bootstrap={createBootstrap(dir, file)} />, WIDE);
      await flush(setup);

      await pressKey(setup, key);

      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe(expected);
      expect(setup.captureCharFrame()).toContain("in f.txt");
      await act(async () => {
        setup!.renderer.destroy();
      });
      setup = undefined;
    }
  });

  test("B refuses a conflict whose markers recorded no base", async () => {
    const withoutBase = CONFLICTED.replace("||||||| parent\nbase line\n", "");
    const { dir, file } = createConflictedRepo(withoutBase);
    setup = await testRender(<AppHost bootstrap={createBootstrap(dir, file)} />, WIDE);
    await flush(setup);

    await pressKey(setup, "B");

    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe(withoutBase);
    expect(setup.captureCharFrame()).toContain("diff3");
  });

  test("a changed working copy is refused instead of being rewritten", async () => {
    const { dir, file } = createConflictedRepo();
    setup = await testRender(<AppHost bootstrap={createBootstrap(dir, file)} />, WIDE);
    await flush(setup);
    writeFileSync(join(dir, "f.txt"), `inserted\n${CONFLICTED}`);

    await pressKey(setup, ">");

    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe(`inserted\n${CONFLICTED}`);
    expect(setup.captureCharFrame()).toContain("reload before resolving");
  });
});
