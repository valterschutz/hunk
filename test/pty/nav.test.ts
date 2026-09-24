import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, pressKeyRepeat, rowCellBackgrounds } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY navigation", () => {
  test("comment navigation resumes from an unannotated hunk in stream order", async () => {
    const fixture = harness.createAgentNavigationRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split", "--agent-context", fixture.agentContext, "--agent-notes"],
      cwd: fixture.dir,
      cols: 160,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("Maximum update depth exceeded");

      const alphaNote = await harness.pressAndWaitForSnapshot(
        session,
        "}",
        (text) => text.includes("Alpha note for navigation."),
        5_000,
      );
      expect(alphaNote).toContain("Alpha note for navigation.");
      expect(alphaNote).not.toContain("Maximum update depth exceeded");

      await harness.pressAndWaitForSnapshot(
        session,
        ".",
        (text) => text.includes("line101 = 10100"),
        5_000,
      );

      const gammaNote = await harness.pressAndWaitForSnapshot(
        session,
        "}",
        (text) => text.includes("Gamma note for navigation."),
        5_000,
      );

      expect(gammaNote).toContain("Gamma note for navigation.");
      expect(gammaNote).not.toContain("Alpha note for navigation.");
      expect(gammaNote).not.toContain("Maximum update depth exceeded");
    } finally {
      session.close();
    }
  });

  test("real hunk navigation jumps to later hunks in the review stream", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      const secondHunk = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (text) => text.includes("line60 = 6000"),
        5_000,
      );

      expect(secondHunk).toContain("line60 = 6000");
      expect(secondHunk).not.toContain("line1 = 100");
    } finally {
      session.close();
    }
  });

  /** Find the on-screen row carrying text, in the same indexing `rowCellBackgrounds` reads. */
  function terminalRowIndex(
    session: { getTerminalData: () => { lines: { spans: { text: string }[] }[] } },
    needle: string,
  ) {
    return session.getTerminalData().lines.findIndex((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes(needle),
    );
  }

  /** Return the background covering most of one captured row: its content tint. */
  function dominantBackground(backgrounds: ReturnType<typeof rowCellBackgrounds>) {
    const counts = new Map<(typeof backgrounds)[number], number>();
    for (const background of backgrounds) {
      counts.set(background, (counts.get(background) ?? 0) + 1);
    }

    return [...counts.entries()].sort(([, left], [, right]) => right - left)[0]?.[0];
  }

  test("hunk navigation stays within the selected file", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 500 });

      const addedRow = terminalRowIndex(session, "export const add = true;");
      const betaRow = terminalRowIndex(session, "export const betaValue = 1;");
      expect(addedRow).toBeGreaterThanOrEqual(0);
      expect(betaRow).toBeGreaterThanOrEqual(0);

      const focusedTint = dominantBackground(rowCellBackgrounds(session, addedRow));
      const fadedTint = dominantBackground(rowCellBackgrounds(session, betaRow));
      expect(focusedTint).not.toBe(fadedTint);

      await session.press("]");
      await session.waitIdle({ timeout: 500 });
      expect(dominantBackground(rowCellBackgrounds(session, addedRow))).toBe(focusedTint);
      expect(dominantBackground(rowCellBackgrounds(session, betaRow))).toBe(fadedTint);

      await session.press(".");
      await session.waitIdle({ timeout: 500 });
      expect(dominantBackground(rowCellBackgrounds(session, addedRow))).toBe(fadedTint);
      expect(dominantBackground(rowCellBackgrounds(session, betaRow))).toBe(focusedTint);

      await session.press("[");
      await session.waitIdle({ timeout: 500 });
      expect(dominantBackground(rowCellBackgrounds(session, addedRow))).toBe(fadedTint);
      expect(dominantBackground(rowCellBackgrounds(session, betaRow))).toBe(focusedTint);
    } finally {
      session.close();
    }
  });

  test("PTY sessions can navigate forward and backward between distant hunks in one large file", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      const secondHunk = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (text) => text.includes("line60 = 6000") && !text.includes("line1 = 100"),
        5_000,
      );

      expect(secondHunk).toContain("line60 = 6000");
      expect(secondHunk).not.toContain("line1 = 100");

      const firstHunk = await harness.pressAndWaitForSnapshot(
        session,
        "[",
        (text) => text.includes("line1 = 100") && !text.includes("line60 = 6000"),
        5_000,
      );

      expect(firstHunk).toContain("line1 = 100");
      expect(firstHunk).not.toContain("line60 = 6000");
    } finally {
      session.close();
    }
  });

  test("file navigation reveals a destination hidden by a collapsed tree folder", async () => {
    const fixture = harness.createNestedSidebarRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/⌄ src\//, { timeout: 15_000 });
      const initialAlphaCount = harness.countMatches(initial, /alpha\.ts/g);
      const initialBetaCount = harness.countMatches(initial, /beta\.ts/g);
      expect(initialAlphaCount).toBeGreaterThanOrEqual(2);
      expect(initialBetaCount).toBeGreaterThanOrEqual(2);

      await session.click(/⌄ src\//);
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("› src/") &&
          harness.countMatches(text, /alpha\.ts/g) === initialAlphaCount - 1 &&
          harness.countMatches(text, /beta\.ts/g) === initialBetaCount - 1,
        5_000,
      );
      expect(collapsed).toContain("› src/");
      expect(collapsed).toContain("2 files");

      const expanded = await harness.pressAndWaitForSnapshot(
        session,
        ".",
        (text) =>
          text.includes("⌄ src/") &&
          harness.countMatches(text, /alpha\.ts/g) === initialAlphaCount &&
          harness.countMatches(text, /beta\.ts/g) === initialBetaCount,
        5_000,
      );
      expect(expanded).toContain("⌄ src/");
    } finally {
      session.close();
    }
  });

  test("sidebar selection jumps the main pane without collapsing the review stream", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("alphaOnly = true");
      expect(initial).toContain("betaValue = 2");
      expect(initial).not.toContain("deltaOnly = true");

      await session.click(/M delta\.ts\s+\+2 -1/);
      const jumped = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("deltaOnly = true") &&
          !text.includes("alphaOnly = true") &&
          harness.countMatches(text, /epsilon\.ts/g) >= 2,
        5_000,
      );

      expect(jumped).toContain("deltaValue = 2");
      expect(jumped).toContain("deltaOnly = true");
      expect(jumped).not.toContain("alphaOnly = true");
      expect(harness.countMatches(jumped, /epsilon\.ts/g)).toBeGreaterThanOrEqual(2);
    } finally {
      session.close();
    }
  });

  test("clicking a sidebar file pins that file header to the top in a real PTY", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("first.ts");
      expect(initial).toContain("second.ts");

      await pressKeyRepeat(session, "down", 16);

      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line08 = 108") && text.includes("first.ts"),
        5_000,
      );

      expect(scrolled).toContain("first.ts");

      await session.click(/M second\.ts\s+\+16 -16/);
      const pinned = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("second.ts") &&
          text.includes("line17 = 117") &&
          harness.countMatches(text, /first\.ts/g) === 1,
        5_000,
      );

      expect(pinned).toContain("second.ts");
      expect(pinned).toContain("line17 = 117");
      expect(harness.countMatches(pinned, /first\.ts/g)).toBe(1);
    } finally {
      session.close();
    }
  });
});
