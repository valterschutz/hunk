import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Children, act, isValidElement, type ReactNode } from "react";
import { capturedTestColorToHex } from "../../../../../test/helpers/test-color-helpers";
import { contrastRatio, hexColorDistance } from "../lib/color";
import { resolveTheme } from "../themes";
import { CodeRowView } from "./CodeRowView";
import { planCodeRowLayout } from "./codeRowLayout";
import type { PlannedCodeReviewRow } from "./reviewRenderPlan";
import {
  cursorLineHighlightBg,
  selectionHighlightBg,
  unifiedCellPalette,
  unifiedRailColor,
} from "./rowStyle";

/** Return the normalized background painted behind matching captured text. */
function backgroundForText(
  capture: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  text: string,
) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.bg)?.toLowerCase();
}

/** Return the normalized foreground of the first captured span carrying text. */
function foregroundForText(
  capture: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  text: string,
) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.fg)?.toLowerCase();
}

test("CodeRowView limits character selections to source text instead of cell chrome", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:character-range",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "unified-line",
      key: "character-range",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "selected" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={true}
      copySelectedRowRange={{ startCol: 5, endCol: 7 }}
    />,
    { width: 20, height: 2 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const spans = setup.captureSpans();
    const palette = unifiedCellPalette("addition", theme);

    expect(backgroundForText(spans, "lec")).toBe(
      selectionHighlightBg(palette.contentBg, theme).toLowerCase(),
    );
    expect(backgroundForText(spans, "se")).toBe(palette.contentBg.toLowerCase());
    expect(backgroundForText(spans, "+ ")).toBe(palette.gutterBg.toLowerCase());
    expect(backgroundForText(spans, "▌")).toBe(theme.panel.toLowerCase());
    expect(foregroundForText(spans, "+ ")).toBe(palette.numberColor.toLowerCase());
    expect(foregroundForText(spans, "▌")).toBe(
      unifiedRailColor("addition", theme, true).toLowerCase(),
    );
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("CodeRowView fades a row outside the focused hunk", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const emphasisBg = "#1b4721";
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:focus",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "unified-line",
      key: "focus",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "value", fg: "#79c0ff", bg: emphasisBg }],
      },
    },
  };

  /** Capture what one focus state paints behind and in the row's word-diff emphasis. */
  const paintRow = async (selected: boolean) => {
    const setup = await testRender(
      <CodeRowView
        plannedRow={plannedRow}
        width={16}
        lineNumberDigits={1}
        showLineNumbers={false}
        wrapLines={false}
        codeHorizontalOffset={0}
        theme={theme}
        selected={selected}
      />,
      { width: 20, height: 2 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const spans = setup.captureSpans();
      return {
        emphasisBg: backgroundForText(spans, "value")!,
        emphasisFg: foregroundForText(spans, "value")!,
        gutterBg: backgroundForText(spans, "+ ")!,
        signFg: foregroundForText(spans, "+ ")!,
        frame: setup.captureCharFrame(),
      };
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  };

  const focused = await paintRow(true);
  const unfocused = await paintRow(false);
  const surface = theme.background.toLowerCase();
  const closerToSurface = (unfocusedColor: string, focusedColor: string) =>
    expect(hexColorDistance(unfocusedColor, surface)).toBeLessThan(
      hexColorDistance(focusedColor, surface),
    );

  expect(focused.emphasisBg).toBe(emphasisBg);
  closerToSurface(unfocused.emphasisBg, focused.emphasisBg);
  closerToSurface(unfocused.emphasisFg, focused.emphasisFg);
  closerToSurface(unfocused.gutterBg, focused.gutterBg);
  closerToSurface(unfocused.signFg, focused.signFg);
  expect(contrastRatio(unfocused.emphasisFg, unfocused.emphasisBg)).toBeGreaterThanOrEqual(2);
  // Fading is paint-only: the row still says exactly what it said.
  expect(unfocused.frame).toBe(focused.frame);
});

test("CodeRowView mounts ordinary wrapped split lines under one hover target", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const hoveredRows: string[] = [];
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:wrapped-fast-path",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "split-line",
      key: "wrapped-fast-path",
      fileId: "paint",
      hunkIndex: 0,
      left: {
        kind: "deletion",
        sign: "-",
        lineNumber: 1,
        spans: [{ text: "abcdefghijklmnopqrstuvwxyz0123456789" }],
      },
      right: {
        kind: "addition",
        sign: "+",
        lineNumber: 1,
        spans: [{ text: "abcdefghijklmnopqrstuvwxyz0123456789" }],
      },
    },
  };

  const rendered = CodeRowView({
    plannedRow,
    width: 20,
    lineNumberDigits: 1,
    showLineNumbers: false,
    wrapLines: true,
    codeHorizontalOffset: 0,
    theme,
    selected: false,
    onHoverRow: (rowKey) => hoveredRows.push(rowKey),
    onStartUserNoteAtHunk: () => {},
  });
  if (
    !isValidElement<{
      children?: ReactNode;
      onMouseMove?: () => void;
    }>(rendered)
  ) {
    throw new Error("Expected CodeRowView to return a wrapped row element");
  }
  const visualLines = Children.toArray(rendered.props.children);

  expect(visualLines.length).toBeGreaterThan(1);
  expect(
    visualLines.every(
      (line) =>
        isValidElement<{ onMouseMove?: () => void }>(line) &&
        line.type === "text" &&
        line.props.onMouseMove === undefined,
    ),
  ).toBe(true);
  const setup = await testRender(rendered, { width: 20, height: 6 });
  try {
    await act(async () => {
      await setup.renderOnce();
      // Exercise a continuation line rather than invoking the parent's prop directly.
      await setup.mockMouse.moveTo(5, 2);
    });
    expect(hoveredRows).toEqual(["wrapped-fast-path"]);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("CodeRowView paints wrapped selection boundaries per visual line", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:wrapped-selection",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "unified-line",
      key: "wrapped-selection",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "abcdefghijklmnopqrstuvwx" }],
      },
    },
  };
  const width = 12;
  const layout = planCodeRowLayout(plannedRow, {
    width,
    lineNumberDigits: 1,
    showLineNumbers: false,
    wrapLines: true,
  });
  if (!layout || layout.kind !== "unified") throw new Error("Expected unified layout");
  const contentStart = layout.cell.prefixWidth + layout.cell.gutterWidth;
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={width}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines
      codeHorizontalOffset={0}
      theme={theme}
      selected={true}
      copySelectedRowRange={{
        startCol: contentStart + 2,
        endCol: width - 1,
        visualLineRanges: [
          { startCol: contentStart + 2, endCol: width - 1 },
          { startCol: 0, endCol: width - 1 },
          { startCol: 0, endCol: contentStart + 1 },
        ],
      }}
    />,
    { width, height: 4 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const lines = setup.captureSpans().lines;
    const selectedBg = selectionHighlightBg(
      unifiedCellPalette("addition", theme).contentBg,
      theme,
    ).toLowerCase();
    const backgroundInLine = (line: (typeof lines)[number], text: string) =>
      capturedTestColorToHex(
        line.spans.find((span) => span.text.includes(text))?.bg,
      )?.toLowerCase();

    expect(backgroundInLine(lines[0]!, "ab")).toBe(
      unifiedCellPalette("addition", theme).contentBg.toLowerCase(),
    );
    expect(backgroundInLine(lines[0]!, "c")).toBe(selectedBg);
    expect(backgroundInLine(lines[1]!, "j")).toBe(selectedBg);
    expect(backgroundInLine(lines[2]!, "s")).toBe(selectedBg);
    expect(backgroundInLine(lines[2]!, "u")).toBe(
      unifiedCellPalette("addition", theme).contentBg.toLowerCase(),
    );
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("CodeRowView gives copy selection precedence over cursor paint", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:precedence",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "unified-line",
      key: "precedence",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "selected" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={true}
      copySelectedRowRange={{ startCol: 0, endCol: Number.MAX_SAFE_INTEGER }}
      cursorHighlight={{ stableKey: plannedRow.stableKey, side: "new", style: "row" }}
    />,
    { width: 20, height: 2 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const background = backgroundForText(setup.captureSpans(), "selected");
    const baseBackground = unifiedCellPalette("addition", theme).contentBg;

    expect(background).toBe(selectionHighlightBg(baseBackground, theme).toLowerCase());
    expect(background).not.toBe(cursorLineHighlightBg(baseBackground, theme).toLowerCase());
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("CodeRowView overlays the nowrap add-note badge instead of shifting the note guide", async () => {
  const theme = resolveTheme("github-dark-default", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:note-guide-hover",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    anchorId: "note-guide",
    noteGuideSide: "new",
    row: {
      type: "unified-line",
      key: "note-guide-hover",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "addition",
        sign: "+",
        newLineNumber: 1,
        spans: [{ text: "selected" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={false}
      showAddNoteBadge
      onStartUserNoteAtHunk={() => {}}
    />,
    { width: 17, height: 2 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const line = setup.captureCharFrame().split("\n")[0] ?? "";

    expect(line.slice(0, 16)).toEndWith("[+]");
    expect(line.slice(0, 16)).not.toContain("│[+]");
    expect(line[16]).toBe("│");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("CodeRowView paints the rail of a verified hunk in the verified color", async () => {
  const theme = resolveTheme("catppuccin-mocha", null);
  const plannedRow: PlannedCodeReviewRow = {
    kind: "diff-row",
    key: "diff-row:verified",
    stableKey: "line:0:new:1",
    fileId: "paint",
    hunkIndex: 0,
    row: {
      type: "unified-line",
      key: "verified",
      fileId: "paint",
      hunkIndex: 0,
      cell: {
        kind: "deletion",
        sign: "-",
        lineNumber: 1,
        spans: [{ text: "verified" }],
      },
    },
  };
  const setup = await testRender(
    <CodeRowView
      plannedRow={plannedRow}
      width={16}
      lineNumberDigits={1}
      showLineNumbers={false}
      wrapLines={false}
      codeHorizontalOffset={0}
      theme={theme}
      selected={true}
      verified={true}
    />,
    { width: 16, height: 1 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const spans = setup.captureSpans();

    expect(foregroundForText(spans, "▌")).toBe(theme.verifiedRailColor.toLowerCase());
    expect(foregroundForText(spans, "▌")).not.toBe(
      unifiedRailColor("deletion", theme, true).toLowerCase(),
    );
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
