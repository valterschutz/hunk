import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type {
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
} from "../session/types";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../../../test/helpers/diff-helpers";
import { createReviewFileStore } from "../core/process/reviewFileStore";
import type { HunkRecord, NoteRecord } from "../core/review/reviewFile";

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");
const { loadAppBootstrap } = await import("../core/changeset/loaders");

const WIDE = { width: 160, height: 36 };

const BEFORE = lines("const alpha = 1;", "const beta = 2;", "const gamma = 3;", "const delta = 4;");
const AFTER = lines("const alpha = 1;", "const beta = 22;", "const gamma = 3;", "const delta = 4;");

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function createMockHostClient() {
  type Bridge = Parameters<HunkSessionBrokerClient["setBridge"]>[0];
  let bridge: Bridge = null;
  let registration: HunkSessionRegistration = {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    launchedAt: "2026-03-24T00:00:00.000Z",
    info: { inputKind: "vcs", title: "repo working tree", sourceLabel: "repo", files: [] },
  };
  return {
    hostClient: {
      getRegistration: () => registration,
      replaceSession: (next: HunkSessionRegistration) => {
        registration = next;
      },
      subscribeConnectionNotice: (listener: (notice: string | null) => void) => {
        listener(null);
        return () => undefined;
      },
      setBridge: (next: Bridge) => {
        bridge = next;
      },
      updateSnapshot: (_snapshot: HunkSessionSnapshot) => {},
    } as unknown as HunkSessionBrokerClient,
    dispatchCommand: async (message: HunkSessionServerMessage) => {
      if (!bridge) throw new Error("Expected AppHost to register its daemon bridge.");
      return bridge.dispatchCommand(message);
    },
  };
}

async function flush(target: Setup) {
  await act(async () => {
    await target.renderOnce();
    await Bun.sleep(0);
    await target.renderOnce();
  });
}

async function press(target: Setup, keys: string) {
  for (const key of keys) {
    await act(async () => {
      await target.mockInput.typeText(key);
    });
    await flush(target);
  }
}

/** Open the composer on the current line, type the note, and save it. */
async function writeNote(target: Setup, text: string) {
  await press(target, "c");
  await act(async () => {
    await target.mockInput.typeText(text);
  });
  await flush(target);
  await act(async () => {
    target.mockInput.pressKey("s", { ctrl: true });
  });
  await flush(target);
}

/** Step down until the note card holding `text` is the active note, then press `key`. */
async function pressOnNote(target: Setup, key: string, until: (frame: string) => boolean) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await press(target, "j");
    await press(target, key);
    if (until(target.captureCharFrame())) return;
  }
  throw new Error(
    `Pressing ${key} on the note never had the expected effect:\n${target.captureCharFrame()}`,
  );
}

function records(reviewFile: string) {
  const { records: all } = createReviewFileStore(reviewFile).load();
  return {
    notes: all.filter((record): record is NoteRecord => record.kind === "note"),
    hunks: all.filter((record): record is HunkRecord => record.kind === "hunk"),
  };
}

function createBootstrap(reviewFile: string, sourceLabel = "repo") {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:persisted-notes",
    initialMode: "unified",
    sourceLabel,
    initialShowAgentNotes: true,
    files: [
      createTestDiffFile({ after: AFTER, before: BEFORE, context: 3, id: "s", path: "s.ts" }),
    ],
    vcsOptions: { reviewFile, cursorLine: "row" },
  });
}

async function mount(bootstrap: Parameters<typeof AppHost>[0]["bootstrap"]) {
  const { dispatchCommand, hostClient } = createMockHostClient();
  const rendered = await testRender(
    <AppHost bootstrap={{ ...bootstrap, initialCursorLine: "row" }} hostClient={hostClient} />,
    WIDE,
  );
  setup = rendered;
  await flush(rendered);
  return { rendered, dispatchCommand };
}

async function unmount() {
  if (!setup) return;
  const current = setup;
  setup = undefined;
  await act(async () => {
    current.renderer.destroy();
  });
}

afterEach(async () => {
  await unmount();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("AppHost persisted notes", () => {
  test("a saved note is written with its hunk, restored on remount, and removed by D", async () => {
    const reviewFile = join(tempDir("hunk-notes-"), "review.jsonl");
    const { rendered } = await mount(createBootstrap(reviewFile));

    await press(rendered, "jj");
    await writeNote(rendered, "Objection here");
    expect(rendered.captureCharFrame()).toContain("Objection here");

    const written = records(reviewFile);
    expect(written.notes).toHaveLength(1);
    expect(written.notes[0]).toMatchObject({
      source: "user",
      summary: "Objection here",
      side: "new",
      offset: 1,
      length: 1,
      line: 2,
      lineText: "const beta = 22;",
    });
    expect(written.hunks).toHaveLength(1);
    expect(written.hunks[0]).toMatchObject({ path: "s.ts", id: written.notes[0]!.hunk });
    expect(written.hunks[0]!.state).toBeUndefined();
    expect("lines" in written.hunks[0]!).toBe(false);

    await unmount();
    const { rendered: again } = await mount(createBootstrap(reviewFile));
    expect(again.captureCharFrame()).toContain("Objection here");

    await pressOnNote(again, "D", (frame) => !frame.includes("Objection here"));
    expect(records(reviewFile)).toEqual({ notes: [], hunks: [] });
  });

  test("an agent reply in the reviewer's thread is persisted, an agent's own note is not", async () => {
    const reviewFile = join(tempDir("hunk-notes-"), "review.jsonl");
    const { rendered, dispatchCommand } = await mount(createBootstrap(reviewFile));

    await press(rendered, "jj");
    await writeNote(rendered, "Please cite this");
    const noteId = records(reviewFile).notes[0]!.id;

    await act(async () => {
      await dispatchCommand({
        type: "command",
        requestId: "reply-1",
        command: "comment",
        input: { sessionId: "session-1", replyTo: noteId, summary: "Cited in the next revision" },
      });
      await dispatchCommand({
        type: "command",
        requestId: "root-1",
        command: "comment",
        input: {
          sessionId: "session-1",
          filePath: "s.ts",
          side: "new",
          line: 3,
          summary: "Agent aside",
        },
      });
    });
    await flush(rendered);

    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Cited in the next revision");
    expect(frame).toContain("Agent aside");
    const { notes } = records(reviewFile);
    expect(notes.map((note) => note.summary)).toEqual([
      "Please cite this",
      "Cited in the next revision",
    ]);
    expect(notes[1]).toMatchObject({ parentId: noteId, source: "agent", id: "mcp:reply-1" });
  });

  test("a reload that drops the note keeps its record for a review that shows the hunk again", async () => {
    const dir = tempDir("hunk-notes-reload-");
    const reviewFile = join(dir, "review.jsonl");
    const left = join(dir, "before.txt");
    const right = join(dir, "after.txt");
    writeFileSync(left, lines("a", "b", "c", "d", "e"));
    writeFileSync(right, lines("a", "b", "c2", "d", "e"));
    const options = { mode: "unified" as const, cursorLine: "row" as const, reviewFile };
    const { rendered, dispatchCommand } = await mount(
      await loadAppBootstrap({ kind: "diff", left, right, options }),
    );

    await press(rendered, "jj");
    await writeNote(rendered, "About c2");
    expect(rendered.captureCharFrame()).toContain("About c2");
    expect(records(reviewFile).notes).toHaveLength(1);

    // The change is reverted: the hunk is gone, so the note leaves the review but not the file.
    writeFileSync(right, lines("a", "b", "c", "d", "e"));
    await act(async () => {
      await dispatchCommand({
        type: "command",
        requestId: "reload-1",
        command: "reload_session",
        input: { sessionId: "session-1", nextInput: { kind: "diff", left, right, options } },
      });
    });
    let frame = rendered.captureCharFrame();
    for (let attempt = 0; attempt < 10 && frame.includes("About c2"); attempt += 1) {
      await act(async () => {
        await Bun.sleep(30);
        await rendered.renderOnce();
      });
      frame = rendered.captureCharFrame();
    }
    expect(frame).not.toContain("About c2");
    expect(records(reviewFile).notes).toHaveLength(1);

    // The change comes back, and so does the note.
    writeFileSync(right, lines("a", "b", "c2", "d", "e"));
    await act(async () => {
      await dispatchCommand({
        type: "command",
        requestId: "reload-2",
        command: "reload_session",
        input: { sessionId: "session-1", nextInput: { kind: "diff", left, right, options } },
      });
    });
    frame = rendered.captureCharFrame();
    for (let attempt = 0; attempt < 10 && !frame.includes("About c2"); attempt += 1) {
      await act(async () => {
        await Bun.sleep(30);
        await rendered.renderOnce();
      });
      frame = rendered.captureCharFrame();
    }
    expect(frame).toContain("About c2");
  });
});
