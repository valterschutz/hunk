import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

/** Wide enough for the sidebar to stay open beside the review stream. */
const WIDE = { width: 200, height: 24 };

const ALPHA_BEFORE = lines(...Array.from({ length: 60 }, (_, index) => `alpha ${index + 1}`));
// Changes every ten lines make the first file's section taller than the viewport, so the
// bottom of the review is somewhere `G` has to scroll to.
const ALPHA_AFTER = [
  ["alpha 2", "alpha head change"],
  ["alpha 12", "alpha second change"],
  ["alpha 22", "alpha third change"],
  ["alpha 32", "alpha fourth change"],
  ["alpha 42", "alpha fifth change"],
  ["alpha 59", "alpha tail change"],
].reduce((text, [before, after]) => text.replace(`${before}\n`, `${after}\n`), ALPHA_BEFORE);
const BETA_BEFORE = lines("beta one", "beta two", "beta three");
const BETA_AFTER = BETA_BEFORE.replace("beta two\n", "beta change\n");

/** A two-file review whose first file is taller than the viewport. */
function createBootstrap({ oneFileAtATime }: { oneFileAtATime?: boolean } = {}) {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:one-file-at-a-time",
    initialMode: "unified",
    files: [
      createTestDiffFile({
        after: ALPHA_AFTER,
        before: ALPHA_BEFORE,
        context: 2,
        id: "alpha",
        path: "src/alpha.ts",
      }),
      createTestDiffFile({
        after: BETA_AFTER,
        before: BETA_BEFORE,
        context: 1,
        id: "beta",
        path: "src/beta.ts",
      }),
    ],
    vcsOptions: oneFileAtATime === undefined ? {} : { oneFileAtATime },
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

async function pressKeys(target: Awaited<ReturnType<typeof testRender>>, keys: string) {
  for (const key of keys) {
    await act(async () => {
      await target.mockInput.typeText(key);
    });
    await flush(target);
  }
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

describe("AppHost one-file-at-a-time review", () => {
  test("the default stream carries the next file's changes into the same scroll", async () => {
    setup = await testRender(<AppHost bootstrap={createBootstrap()} />, WIDE);
    await flush(setup);

    // Jumping to the end of the review reaches the last file without any file navigation.
    await pressKeys(setup, "G");

    expect(setup.captureCharFrame()).toContain("beta change");
  });

  test("one_file_at_a_time bounds the stream to the selected file", async () => {
    setup = await testRender(
      <AppHost bootstrap={createBootstrap({ oneFileAtATime: true })} />,
      WIDE,
    );
    await flush(setup);

    let frame = setup.captureCharFrame();
    expect(frame).toContain("alpha head change");
    expect(frame).not.toContain("beta change");
    // The sidebar keeps listing every file even though the stream holds one.
    expect(frame).toContain("beta.ts");

    // The end of the review is the end of this file, not the start of the next one.
    await pressKeys(setup, "G");

    frame = setup.captureCharFrame();
    expect(frame).toContain("alpha tail change");
    // The scroll really moved — the file's first change is off screen above.
    expect(frame).not.toContain("alpha head change");
    expect(frame).not.toContain("beta change");
  });

  test(". and , are the way between files, landing on each file's header", async () => {
    setup = await testRender(
      <AppHost bootstrap={createBootstrap({ oneFileAtATime: true })} />,
      WIDE,
    );
    await flush(setup);

    await pressKeys(setup, ".");

    let frame = setup.captureCharFrame();
    expect(frame).toContain("beta change");
    expect(frame).not.toContain("alpha head change");
    expect(frame).not.toContain("alpha tail change");

    await pressKeys(setup, ",");

    // Back on the first file at its header, not at the scroll offset it was left at.
    frame = setup.captureCharFrame();
    expect(frame).toContain("alpha head change");
    expect(frame).not.toContain("beta change");
  });
});
