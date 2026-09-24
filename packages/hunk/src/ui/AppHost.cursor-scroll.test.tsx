import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { CursorScroll } from "../core/run/commandInputs";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

const SIZE = { width: 120, height: 24 };

const BEFORE = lines(
  ...Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, "0")}`),
);
// Changes at both ends with generous context fold the whole file into one hunk, so every `j`
// steps to the next numbered line.
const AFTER = BEFORE.replace("line 02\n", "line 02 changed\n").replace(
  "line 79\n",
  "line 79 changed\n",
);

function createBootstrap(cursorScroll?: CursorScroll) {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:cursor-scroll",
    initialMode: "unified",
    initialShowMenuBar: false,
    files: [
      createTestDiffFile({
        after: AFTER,
        before: BEFORE,
        context: 100,
        id: "sample",
        path: "src/sample.ts",
      }),
    ],
    vcsOptions: cursorScroll === undefined ? {} : { cursorScroll },
  });
}

/** Settle the render, including the row measurement `DiffSectionBody` commits after mount. */
async function flush(target: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await target.renderOnce();
    await Bun.sleep(100);
    await target.renderOnce();
  });
}

async function pressKey(target: Awaited<ReturnType<typeof testRender>>, key: string, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await target.mockInput.typeText(key);
    });
    await flush(target);
  }
}

/** Find the frame row one rendered line occupies, or -1 when it is off screen. */
function frameRowOf(target: Awaited<ReturnType<typeof testRender>>, needle: string) {
  return target
    .captureCharFrame()
    .split("\n")
    .findIndex((row) => row.includes(needle));
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (setup) {
    const current = setup;
    setup = undefined;
    await act(async () => {
      current.renderer.destroy();
    });
  }
});

describe("AppHost cursor_scroll", () => {
  test("nearest stepping leaves the viewport alone while the line is on screen", async () => {
    setup = await testRender(<AppHost bootstrap={createBootstrap()} />, SIZE);
    await flush(setup);

    const topRowBefore = frameRowOf(setup, "line 01");
    expect(topRowBefore).toBeGreaterThanOrEqual(0);

    await pressKey(setup, "j", 15);

    expect(frameRowOf(setup, "line 01")).toBe(topRowBefore);
    expect(frameRowOf(setup, "line 16")).toBeGreaterThan(topRowBefore);
  });

  test("center stepping scrolls the stream so the current line stays mid-viewport", async () => {
    setup = await testRender(<AppHost bootstrap={createBootstrap("center")} />, SIZE);
    await flush(setup);

    // Past the top-of-stream clamp, each step moves the stream by one row and the current line
    // keeps its screen row.
    await pressKey(setup, "j", 15);
    const cursorRow = frameRowOf(setup, "line 16");
    expect(cursorRow).toBeGreaterThan(0);
    expect(frameRowOf(setup, "line 01")).toBe(-1);

    await pressKey(setup, "j");

    expect(frameRowOf(setup, "line 17")).toBe(cursorRow);
    expect(frameRowOf(setup, "line 16")).toBe(cursorRow - 1);

    await pressKey(setup, "k", 3);

    expect(frameRowOf(setup, "line 14")).toBe(cursorRow);
  });

  test("center places the current line at the middle of the review viewport", async () => {
    setup = await testRender(<AppHost bootstrap={createBootstrap("center")} />, SIZE);
    await flush(setup);

    await pressKey(setup, "j", 40);

    const frame = setup.captureCharFrame().split("\n");
    const cursorRow = frame.findIndex((row) => row.includes("line 41"));
    const codeRows = frame.filter((row) => /line \d\d/.test(row)).length;
    const firstCodeRow = frame.findIndex((row) => /line \d\d/.test(row));
    // The rendered code rows are the review viewport; the current line sits in the middle of it.
    expect(Math.abs(cursorRow - firstCodeRow - Math.floor((codeRows - 1) / 2))).toBeLessThanOrEqual(
      1,
    );
  });
});
