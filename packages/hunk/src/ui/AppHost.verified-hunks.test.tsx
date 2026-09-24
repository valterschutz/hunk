import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
import { resolveTheme } from "./themes";

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

const WIDE = { width: 200, height: 40 };

const BEFORE = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
const AFTER = BEFORE.replace("line 3\n", "first change\n").replace("line 15\n", "second change\n");
const OTHER_BEFORE = lines("alpha", "beta", "gamma");
const OTHER_AFTER = lines("alpha", "other change", "gamma");

const tempDirs: string[] = [];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;

function createVerifiedHunksFile() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-apphost-verified-"));
  tempDirs.push(dir);
  return join(dir, "verified-hunks");
}

/** Bootstrap a two-file review: `sample.ts` has two hunks and `other.ts` one. */
function createBootstrap(verifiedHunksFile: string | undefined) {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:verified-hunks",
    initialMode: "unified",
    files: [
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
    ],
    vcsOptions: verifiedHunksFile === undefined ? {} : { verifiedHunksFile },
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

describe("AppHost verified hunks", () => {
  test("! hides the selected hunk, records it, and V brings it back", async () => {
    const verifiedHunksFile = createVerifiedHunksFile();
    setup = await testRender(<AppHost bootstrap={createBootstrap(verifiedHunksFile)} />, WIDE);
    await flush(setup);

    let frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).toContain("second change");
    expect(frame).not.toContain("verified");

    await pressKeys(setup, "!");

    frame = setup.captureCharFrame();
    expect(frame).not.toContain("first change");
    expect(frame).toContain("second change");
    expect(frame).toContain("1 verified hunk hidden");
    const stored = readFileSync(verifiedHunksFile, "utf8").trim().split("\n");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^[0-9a-f]{32}$/);

    await pressKeys(setup, "V");

    frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).not.toContain("verified");

    // The selection followed the second hunk while the first was hidden; step back onto
    // the verified one, which the status line then names, and ! unmarks it.
    await pressKeys(setup, "[");
    expect(setup.captureCharFrame()).toContain("selected hunk verified");
    expect(railColorOfLine(setup, "first change")).toBe(
      resolveTheme("github-dark-default", null).verifiedRailColor.toLowerCase(),
    );
    expect(railColorOfLine(setup, "second change")).not.toBe(
      railColorOfLine(setup, "first change"),
    );

    await pressKeys(setup, "!");

    frame = setup.captureCharFrame();
    expect(frame).toContain("first change");
    expect(frame).not.toContain("verified");
    expect(readFileSync(verifiedHunksFile, "utf8")).toBe("");
  });

  test("verifying every hunk of a file removes the file and moves on to the next", async () => {
    const verifiedHunksFile = createVerifiedHunksFile();
    setup = await testRender(<AppHost bootstrap={createBootstrap(verifiedHunksFile)} />, WIDE);
    await flush(setup);

    // After the first hunk hides, the second one takes its place as the selection.
    await pressKeys(setup, "!!");

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("first change");
    expect(frame).not.toContain("second change");
    expect(frame).not.toContain("sample.ts");
    expect(frame).toContain("other change");
    expect(frame).toContain("2 verified hunks hidden");
    expect(readFileSync(verifiedHunksFile, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("without a configured file, ! explains how to enable verifying", async () => {
    setup = await testRender(<AppHost bootstrap={createBootstrap(undefined)} />, WIDE);
    await flush(setup);

    await pressKeys(setup, "!");

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Set verified_hunks_file");
    expect(frame).toContain("first change");
    expect(existsSync(join(tmpdir(), "verified-hunks"))).toBe(false);
  });
});
