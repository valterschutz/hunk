import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import {
  buildEditorCommand,
  openSelectedFileInEditor,
  openSelectedFileInEditorSplit,
  resolveEditableFilePath,
  shouldSuspendForEditor,
} from "./openInEditor";

const originalEditor = process.env.EDITOR;
const originalHerdrEnv = process.env.HERDR_ENV;
const originalSpawnSync = Bun.spawnSync;
const tempDirs: string[] = [];

function createTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-open-editor-")));
  tempDirs.push(dir);
  return dir;
}

function restoreEditorEnv() {
  if (originalEditor === undefined) {
    delete process.env.EDITOR;
  } else {
    process.env.EDITOR = originalEditor;
  }

  if (originalHerdrEnv === undefined) {
    delete process.env.HERDR_ENV;
  } else {
    process.env.HERDR_ENV = originalHerdrEnv;
  }
}

function mockSpawnSync(
  implementation: (cmds: string[], options?: Parameters<typeof Bun.spawnSync>[1]) => unknown,
) {
  const mutableBun = Bun as unknown as { spawnSync: typeof Bun.spawnSync };
  mutableBun.spawnSync = implementation as typeof Bun.spawnSync;
}

function createRenderer() {
  return {
    isDestroyed: false,
    resume: mock(() => {}),
    suspend: mock(() => {}),
  };
}

afterEach(() => {
  restoreEditorEnv();
  mockSpawnSync(originalSpawnSync);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("open in editor helpers", () => {
  test("builds vi-style editor args without shell quoting", () => {
    expect(
      buildEditorCommand({
        editor: "nvim",
        filePath: "/tmp/project/file with spaces's.ts",
        line: 12,
      }),
    ).toEqual({
      command: "nvim",
      args: ["+12", "/tmp/project/file with spaces's.ts"],
    });
  });

  test("preserves editor flags before appending the target file", () => {
    expect(
      buildEditorCommand({
        editor: "code --reuse-window",
        filePath: "/tmp/project/example.ts",
        line: 4,
      }),
    ).toEqual({
      command: "code",
      args: ["--reuse-window", "--goto", "/tmp/project/example.ts:4"],
    });
  });

  test("handles quoted editor commands and Windows executable paths", () => {
    expect(
      buildEditorCommand({
        editor: '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait',
        filePath: "C:\\Users\\Duarte\\repo\\file with spaces.ts",
        line: 7,
      }),
    ).toEqual({
      command: "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
      args: ["--wait", "--goto", "C:\\Users\\Duarte\\repo\\file with spaces.ts:7"],
    });
  });

  test("builds path:line targets for zed and zeditor", () => {
    expect(
      buildEditorCommand({
        editor: "zed --wait",
        filePath: "/tmp/project/file.ts",
        line: 123,
      }),
    ).toEqual({
      command: "zed",
      args: ["--wait", "/tmp/project/file.ts:123"],
    });
    expect(
      buildEditorCommand({
        editor: "zeditor",
        filePath: "/tmp/project/file.ts",
        line: 123,
      }),
    ).toEqual({
      command: "zeditor",
      args: ["/tmp/project/file.ts:123"],
    });
  });

  test("builds path:line targets for hx and wrapper scripts around it", () => {
    expect(
      buildEditorCommand({
        editor: "hx",
        filePath: "/tmp/project/file.ts",
        line: 123,
      }),
    ).toEqual({
      command: "hx",
      args: ["/tmp/project/file.ts:123"],
    });
    expect(
      buildEditorCommand({
        editor: "helix",
        filePath: "/tmp/project/file.ts",
        line: 123,
      }),
    ).toEqual({
      command: "helix",
      args: ["/tmp/project/file.ts:123"],
    });
    expect(
      buildEditorCommand({
        editor: "/home/user/bin/hx-wrapper",
        filePath: "/tmp/project/file.ts",
        line: 123,
      }),
    ).toEqual({
      command: "/home/user/bin/hx-wrapper",
      args: ["/tmp/project/file.ts:123"],
    });
  });

  test("defaults unknown editors to opening the file path only", () => {
    expect(
      buildEditorCommand({
        editor: "unknown-editor --flag",
        filePath: "/tmp/project/example.ts",
        line: 4,
      }),
    ).toEqual({
      command: "unknown-editor",
      args: ["--flag", "/tmp/project/example.ts"],
    });
  });

  test("does not suspend for code-style GUI editors", () => {
    expect(shouldSuspendForEditor("code --reuse-window")).toBe(false);
    expect(shouldSuspendForEditor('"C:\\Program Files\\Cursor\\cursor.exe"')).toBe(false);
    expect(shouldSuspendForEditor("nvim")).toBe(true);
  });

  test("resolves repo-relative diff paths from the diff source path", () => {
    expect(resolveEditableFilePath("src/main.tsx", "/tmp/project")).toBe(
      resolve("/tmp/project", "src/main.tsx"),
    );
  });

  test("returns an error when no file is selected", () => {
    const renderer = createRenderer();
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    expect(
      openSelectedFileInEditor({
        file: undefined,
        renderer,
        selectedHunk: undefined,
      }),
    ).toBe("No file selected.");

    expect(spawnCalls).toEqual([]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("returns an error when $EDITOR is unset", () => {
    const renderer = createRenderer();
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });
    delete process.env.EDITOR;

    expect(
      openSelectedFileInEditor({
        file: createTestDiffFile({ path: "missing-editor.ts" }),
        renderer,
        selectedHunk: undefined,
      }),
    ).toBe("$EDITOR is not set.");

    expect(spawnCalls).toEqual([]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("returns an error when the file does not exist on disk", () => {
    const renderer = createRenderer();
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });
    process.env.EDITOR = "nvim";

    expect(
      openSelectedFileInEditor({
        basePath: createTempDir(),
        file: createTestDiffFile({ path: "missing-on-disk.ts" }),
        renderer,
        selectedHunk: undefined,
      }),
    ).toBe("Cannot edit missing-on-disk.ts: file does not exist on disk.");

    expect(spawnCalls).toEqual([]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("spawns terminal editors with suspend and resume around a successful edit", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "nvim --clean";

    const spawnCalls: Array<{
      cmds: string[];
      options: Parameters<typeof Bun.spawnSync>[1] | undefined;
    }> = [];
    mockSpawnSync((cmds, options) => {
      spawnCalls.push({ cmds, options });
      return { exitCode: 0 };
    });

    const renderer = createRenderer();
    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer,
        selectedHunk: undefined,
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([
      {
        cmds: ["nvim", "--clean", "+1", join(basePath, "example.ts")],
        options: { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      },
    ]);
    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });

  test("opens the current line instead of the selected hunk start", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        lineCursor: {
          fileId: file.id,
          hunkIndex: 1,
          target: { side: "new", line: 3 },
        },
        renderer: createRenderer(),
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([["vim", "+3", join(basePath, "example.ts")]]);
  });

  test("maps an old-side current line onto the line on disk", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "one\nfour\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const file = createTestDiffFile({
      path: "example.ts",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nfour\n",
    });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        lineCursor: {
          fileId: file.id,
          hunkIndex: 0,
          target: { side: "old", line: 3 },
        },
        renderer: createRenderer(),
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([["vim", "+2", join(basePath, "example.ts")]]);
  });

  test("walks leading context when mapping an old-side current line", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "one\nfour\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const file = createTestDiffFile({
      path: "example.ts",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nfour\n",
      context: 1,
    });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        lineCursor: {
          fileId: file.id,
          hunkIndex: 0,
          target: { side: "old", line: 3 },
        },
        renderer: createRenderer(),
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBeNull();

    // Old line 3 ("three") was removed, so the editor lands on the line that now follows "one".
    expect(spawnCalls).toEqual([["vim", "+2", join(basePath, "example.ts")]]);
  });

  test("preserves the deleted line's offset within a multi-line replacement", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "one\nTWO\nTHREE\nfour\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const file = createTestDiffFile({
      path: "example.ts",
      before: "one\ntwo\nthree\nfour\n",
      after: "one\nTWO\nTHREE\nfour\n",
    });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        lineCursor: {
          fileId: file.id,
          hunkIndex: 0,
          target: { side: "old", line: 3 },
        },
        renderer: createRenderer(),
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBeNull();

    // Old line 3 ("three") is the second of two replaced lines, so the editor
    // lands on the second replacement line ("THREE") rather than the first.
    expect(spawnCalls).toEqual([["vim", "+3", join(basePath, "example.ts")]]);
  });

  test("falls back to the selected hunk when the cursor is in another file", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        lineCursor: {
          fileId: "other-file",
          hunkIndex: 0,
          target: { side: "new", line: 42 },
        },
        renderer: createRenderer(),
        selectedHunk: file.metadata.hunks[1],
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([
      ["vim", `+${file.metadata.hunks[1]!.additionStart}`, join(basePath, "example.ts")],
    ]);
  });

  test("uses deletion line numbers for deleted files", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "deleted.ts"), "const old = true;\n");
    process.env.EDITOR = "vim";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    const baseFile = createTestDiffFile({ path: "deleted.ts" });
    const file = {
      ...baseFile,
      metadata: {
        ...baseFile.metadata,
        type: "deleted" as const,
      },
    };
    const selectedHunk = {
      ...file.metadata.hunks[0]!,
      additionStart: 2,
      deletionStart: 9,
    };

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer: createRenderer(),
        selectedHunk,
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([["vim", "+9", join(basePath, "deleted.ts")]]);
  });

  test("does not suspend GUI editors and reports non-zero exits", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "code --wait";

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 2 };
    });

    const renderer = createRenderer();
    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBe("Editor exited with status 2.");

    expect(spawnCalls).toEqual([["code", "--wait", "--goto", `${join(basePath, "example.ts")}:1`]]);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  test("resumes after spawn failures and reports launch errors", () => {
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");
    process.env.EDITOR = "vi";

    mockSpawnSync(() => {
      throw new Error("boom");
    });

    const renderer = createRenderer();
    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditor({
        basePath,
        file,
        renderer,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBe("Failed to launch editor: boom");

    expect(renderer.suspend).toHaveBeenCalledTimes(1);
    expect(renderer.resume).toHaveBeenCalledTimes(1);
  });
});

describe("openSelectedFileInEditorSplit", () => {
  test("returns an error when not running inside a Herdr-managed pane", () => {
    delete process.env.HERDR_ENV;
    process.env.EDITOR = "hx";
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    expect(
      openSelectedFileInEditorSplit({
        file: createTestDiffFile({ path: "example.ts" }),
        selectedHunk: undefined,
      }),
    ).toBe("Not running inside a Herdr-managed pane.");

    expect(spawnCalls).toEqual([]);
  });

  test("returns an error when no file is selected", () => {
    process.env.HERDR_ENV = "1";
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    expect(
      openSelectedFileInEditorSplit({
        file: undefined,
        selectedHunk: undefined,
      }),
    ).toBe("No file selected.");

    expect(spawnCalls).toEqual([]);
  });

  test("returns an error when $EDITOR is unset", () => {
    process.env.HERDR_ENV = "1";
    delete process.env.EDITOR;
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    expect(
      openSelectedFileInEditorSplit({
        file: createTestDiffFile({ path: "missing-editor.ts" }),
        selectedHunk: undefined,
      }),
    ).toBe("$EDITOR is not set.");

    expect(spawnCalls).toEqual([]);
  });

  test("returns an error when the file does not exist on disk", () => {
    process.env.HERDR_ENV = "1";
    process.env.EDITOR = "hx";
    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      return { exitCode: 0 };
    });

    expect(
      openSelectedFileInEditorSplit({
        basePath: createTempDir(),
        file: createTestDiffFile({ path: "missing-on-disk.ts" }),
        selectedHunk: undefined,
      }),
    ).toBe("Cannot edit missing-on-disk.ts: file does not exist on disk.");

    expect(spawnCalls).toEqual([]);
  });

  test("splits a Herdr pane below and runs the editor command in it", () => {
    process.env.HERDR_ENV = "1";
    process.env.EDITOR = "hx";
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      if (cmds[1] === "pane" && cmds[2] === "split") {
        return { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }) };
      }
      return { exitCode: 0, stdout: "" };
    });

    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditorSplit({
        basePath,
        file,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBeNull();

    expect(spawnCalls).toEqual([
      [
        "herdr",
        "pane",
        "split",
        "--current",
        "--direction",
        "down",
        "--focus",
        "--cwd",
        process.cwd(),
      ],
      [
        "herdr",
        "pane",
        "run",
        "w1:p2",
        `hx ${join(basePath, "example.ts")}:1; herdr pane close w1:p2`,
      ],
    ]);
  });

  test("leaves the bareword command unquoted but quotes a file path with a space", () => {
    // Nushell parses a quoted leading token as a string literal rather than a command
    // to run, so quoting the editor name (e.g. `'hx' '/path'`) fails there even though
    // it works in bash. Only arguments that actually need quoting should be quoted.
    process.env.HERDR_ENV = "1";
    process.env.EDITOR = "hx";
    const basePath = createTempDir();
    writeFileSync(join(basePath, "my file.ts"), "const value = 1;\n");

    const spawnCalls: string[][] = [];
    mockSpawnSync((cmds) => {
      spawnCalls.push(cmds);
      if (cmds[1] === "pane" && cmds[2] === "split") {
        return { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }) };
      }
      return { exitCode: 0, stdout: "" };
    });

    const file = createTestDiffFile({ path: "my file.ts" });

    expect(
      openSelectedFileInEditorSplit({
        basePath,
        file,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBeNull();

    expect(spawnCalls[1]).toEqual([
      "herdr",
      "pane",
      "run",
      "w1:p2",
      `hx '${join(basePath, "my file.ts")}:1'; herdr pane close w1:p2`,
    ]);
  });

  test("reports a failure when the pane split fails", () => {
    process.env.HERDR_ENV = "1";
    process.env.EDITOR = "hx";
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");

    mockSpawnSync(() => ({ exitCode: 1, stdout: "", stderr: "no such pane" }));

    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditorSplit({
        basePath,
        file,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBe("Failed to split Herdr pane: no such pane");
  });

  test("reports a failure when launching the editor in the split pane fails", () => {
    process.env.HERDR_ENV = "1";
    process.env.EDITOR = "hx";
    const basePath = createTempDir();
    writeFileSync(join(basePath, "example.ts"), "const value = 1;\n");

    mockSpawnSync((cmds) => {
      if (cmds[1] === "pane" && cmds[2] === "split") {
        return { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }) };
      }
      return { exitCode: 1, stdout: "", stderr: "pane busy" };
    });

    const file = createTestDiffFile({ path: "example.ts" });

    expect(
      openSelectedFileInEditorSplit({
        basePath,
        file,
        selectedHunk: file.metadata.hunks[0],
      }),
    ).toBe("Failed to launch editor in split pane: pane busy");
  });
});
