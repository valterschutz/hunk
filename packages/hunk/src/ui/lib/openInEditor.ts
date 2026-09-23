import { existsSync } from "node:fs";
import { basename, resolve, win32 } from "node:path";
import type { CliRenderer } from "@opentui/core";
import type { DiffFile } from "../../core/changeset/model";
import type { LineCursor } from "./lineCursors";

export interface EditorCommand {
  command: string;
  args: string[];
}

type DiffHunk = DiffFile["metadata"]["hunks"][number];

/** The review stream's current line, minus the geometry fields this module never reads. */
export type EditorLineCursor = Pick<LineCursor, "fileId" | "hunkIndex" | "target">;

/**
 * Translate an old-side line to the line it maps to in the file on disk.
 *
 * Deleted lines have no on-disk counterpart, so they resolve to the position their
 * replacement occupies, which is where the reader expects the editor to land.
 */
function deletionLineToFileLine(hunk: DiffHunk, deletionLine: number) {
  let deletionCursor = hunk.deletionStart;
  // A zero-count side names the line before the change, so step past it to land inside the file.
  let additionCursor = hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart;

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      if (deletionLine < deletionCursor + content.lines) {
        return additionCursor + (deletionLine - deletionCursor);
      }

      deletionCursor += content.lines;
      additionCursor += content.lines;
      continue;
    }

    if (deletionLine < deletionCursor + content.deletions) {
      // Land on the corresponding replacement line, clamped to the last one this block adds.
      const offset = Math.min(deletionLine - deletionCursor, Math.max(content.additions - 1, 0));
      return additionCursor + offset;
    }

    deletionCursor += content.deletions;
    additionCursor += content.additions;
  }

  return additionCursor;
}

/** Prefer the current line over the selected hunk's first line. */
function selectedLine(
  file: DiffFile,
  selectedHunk: DiffHunk | undefined,
  lineCursor: EditorLineCursor | null | undefined,
) {
  // Deleted files are opened against their pre-change content, every other file against its new one.
  const isDeleted = file.metadata.type === "deleted";
  const diskSide = isDeleted ? "old" : "new";
  const cursor = lineCursor?.fileId === file.id ? lineCursor : undefined;

  if (cursor) {
    if (cursor.target.side === diskSide) {
      return cursor.target.line;
    }

    const cursorHunk = file.metadata.hunks[cursor.hunkIndex];
    if (!isDeleted && cursorHunk) {
      return deletionLineToFileLine(cursorHunk, cursor.target.line);
    }
  }

  if (isDeleted) {
    return selectedHunk?.deletionStart ?? 1;
  }

  return selectedHunk?.additionStart ?? 1;
}

function splitEditorCommand(editor: string) {
  return (
    editor
      .match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g)
      ?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? []
  );
}

function editorProgram(editor: string) {
  const [firstToken = ""] = splitEditorCommand(editor);
  return basename(win32.basename(firstToken))
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
}

const VI_STYLE_EDITORS = ["vim", "nvim", "vi"];
const CODE_STYLE_EDITORS = ["code", "code-insiders", "cursor"];
const HELIX_STYLE_EDITORS = ["hx", "helix", "hx-wrapper"];

/** Suspend for terminal editors. */
export function shouldSuspendForEditor(editor: string) {
  const program = editorProgram(editor);
  if (CODE_STYLE_EDITORS.includes(program)) {
    return false;
  }

  return true;
}

/** Build an editor process invocation without shell quoting so paths stay cross-platform. */
export function buildEditorCommand({
  editor,
  filePath,
  line,
}: {
  editor: string;
  filePath: string;
  line: number;
}): EditorCommand {
  const [command = "", ...editorArgs] = splitEditorCommand(editor);
  const program = editorProgram(editor);

  if (VI_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, `+${line}`, filePath] };
  }

  if (CODE_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, "--goto", `${filePath}:${line}`] };
  }

  if (HELIX_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, `${filePath}:${line}`] };
  }

  if (program === "zed" || program === "zeditor") {
    return { command, args: [...editorArgs, `${filePath}:${line}`] };
  }

  return { command, args: [...editorArgs, filePath] };
}

/** Resolve diff paths relative to their source repo instead of the launch cwd. */
export function resolveEditableFilePath(filePath: string, basePath = process.cwd()) {
  return resolve(basePath, filePath);
}

/** Open the selected file in $EDITOR, suspending TUI for terminal editors. */
export function openSelectedFileInEditor({
  basePath,
  file,
  lineCursor,
  renderer,
  selectedHunk,
}: {
  basePath?: string;
  file: DiffFile | undefined;
  lineCursor?: EditorLineCursor | null;
  renderer: Pick<CliRenderer, "suspend" | "resume" | "isDestroyed">;
  selectedHunk: DiffHunk | undefined;
}) {
  if (!file) {
    return "No file selected.";
  }

  const editor = process.env.EDITOR?.trim();
  if (!editor) {
    return "$EDITOR is not set.";
  }

  const absolutePath = resolveEditableFilePath(file.path, basePath);
  if (!existsSync(absolutePath)) {
    return `Cannot edit ${file.path}: file does not exist on disk.`;
  }

  const line = Math.max(1, selectedLine(file, selectedHunk, lineCursor));
  const command = buildEditorCommand({
    editor,
    filePath: absolutePath,
    line,
  });

  const shouldSuspend = shouldSuspendForEditor(editor);
  if (shouldSuspend) {
    renderer.suspend();
  }

  let exitCode = 0;
  let failureMessage: string | null = null;
  try {
    const result = Bun.spawnSync([command.command, ...command.args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = result.exitCode;
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }

  if (shouldSuspend && !renderer.isDestroyed) {
    renderer.resume();
  }

  if (failureMessage) {
    return `Failed to launch editor: ${failureMessage}`;
  }

  if (exitCode !== 0) {
    return `Editor exited with status ${exitCode}.`;
  }

  return null;
}

const SHELL_SAFE_TOKEN = /^[\w./:@=+-]+$/;

/**
 * Quote one argument for the shell command line `herdr pane run` sends to the target pane,
 * leaving already-safe tokens bare.
 *
 * The target pane's shell isn't known — it could be POSIX (bash, zsh) or Nushell, and the
 * two disagree about quoting in command position: Nushell parses a quoted leading token as a
 * string literal rather than a command to run (needing a `^` sigil bash doesn't understand),
 * while both agree a bareword needs no quoting. Since real `$EDITOR` values and their flags
 * never need quoting, staying bare there sidesteps the disagreement entirely; only arguments
 * (typically file paths) may need quotes, and plain single-quoting them parses the same way
 * in both shell families.
 */
function shellQuoteArg(arg: string) {
  return SHELL_SAFE_TOKEN.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellQuoteCommand(command: EditorCommand) {
  return [command.command, ...command.args].map(shellQuoteArg).join(" ");
}

/** The pane id `herdr pane split` reports for the pane it just created, or nothing if unparseable. */
function parseHerdrSplitPaneId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const paneId = parsed.result?.pane?.pane_id;
    return typeof paneId === "string" ? paneId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the selected file in $EDITOR inside a new Herdr pane split below the caller's.
 *
 * Unlike {@link openSelectedFileInEditor}, this never suspends the terminal renderer: the
 * review stays visible in its own pane while the editor runs in the new one, which is the
 * point — editing a file while the agent's suggested diff for it stays on screen.
 */
export function openSelectedFileInEditorSplit({
  basePath,
  file,
  lineCursor,
  selectedHunk,
}: {
  basePath?: string;
  file: DiffFile | undefined;
  lineCursor?: EditorLineCursor | null;
  selectedHunk: DiffHunk | undefined;
}): string | null {
  if (!file) {
    return "No file selected.";
  }

  const editor = process.env.EDITOR?.trim();
  if (!editor) {
    return "$EDITOR is not set.";
  }

  if (process.env.HERDR_ENV !== "1") {
    return "Not running inside a Herdr-managed pane.";
  }

  const absolutePath = resolveEditableFilePath(file.path, basePath);
  if (!existsSync(absolutePath)) {
    return `Cannot edit ${file.path}: file does not exist on disk.`;
  }

  const line = Math.max(1, selectedLine(file, selectedHunk, lineCursor));
  const command = buildEditorCommand({ editor, filePath: absolutePath, line });

  const split = Bun.spawnSync(
    ["herdr", "pane", "split", "--current", "--direction", "down", "--focus", "--cwd", process.cwd()],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (split.exitCode !== 0) {
    const stderr = split.stderr.toString().trim();
    return `Failed to split Herdr pane: ${stderr || `exit status ${split.exitCode}`}`;
  }

  const paneId = parseHerdrSplitPaneId(split.stdout.toString());
  if (!paneId) {
    return "Failed to split Herdr pane: unexpected response.";
  }

  // `;` rather than `&&`: Nushell has no `&&` (it wants `and`, which bash doesn't understand),
  // so unconditional sequencing is the one syntax both shell families agree on. The pane
  // closes once the editor exits either way, rather than staying open after a clean exit.
  const runLine = `${shellQuoteCommand(command)}; herdr pane close ${paneId}`;
  const run = Bun.spawnSync(["herdr", "pane", "run", paneId, runLine], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (run.exitCode !== 0) {
    const stderr = run.stderr.toString().trim();
    return `Failed to launch editor in split pane: ${stderr || `exit status ${run.exitCode}`}`;
  }

  return null;
}
