import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
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

const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");
const { loadAppBootstrap } = await import("../core/changeset/loaders");

const WIDE = { width: 160, height: 30 };

const BEFORE = lines("const alpha = 1;", "const beta = 2;", "const gamma = 3;", "const delta = 4;");
const AFTER = lines("const alpha = 1;", "const beta = 22;", "const gamma = 3;", "const delta = 4;");

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

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

async function mountWithAgentNote() {
  const { dispatchCommand, hostClient } = createMockHostClient();
  const rendered = await testRender(
    <AppHost
      bootstrap={{
        ...createTestVcsAppBootstrap({
          initialMode: "unified",
          initialShowAgentNotes: true,
          files: [
            createTestDiffFile({ after: AFTER, before: BEFORE, context: 3, id: "s", path: "s.ts" }),
          ],
        }),
        initialCursorLine: "row",
      }}
      hostClient={hostClient}
    />,
    WIDE,
  );
  setup = rendered;
  await flush(rendered);
  await act(async () => {
    await dispatchCommand({
      type: "command",
      requestId: "comment-1",
      command: "comment",
      input: {
        sessionId: "session-1",
        filePath: "s.ts",
        side: "new",
        line: 2,
        summary: "Agent says hi",
      },
    });
  });
  await flush(rendered);
  return { rendered };
}

afterEach(async () => {
  if (setup) {
    const current = setup;
    setup = undefined;
    await act(async () => {
      current.renderer.destroy();
    });
  }
});

describe("keyboard actions on a focused agent note", () => {
  test("D deletes the focused note (control)", async () => {
    const { rendered } = await mountWithAgentNote();
    expect(rendered.captureCharFrame()).toContain("Agent says hi");
    await press(rendered, "jjj");
    await press(rendered, "D");
    expect(rendered.captureCharFrame()).not.toContain("Agent says hi");
  });

  test("R opens a reply composer under the note", async () => {
    const { rendered } = await mountWithAgentNote();
    await press(rendered, "jjj");
    await press(rendered, "R");
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Reply");
    expect(frame).toContain("Write a note");
  });
});

describe("notes after a reload that moved their lines", () => {
  test("a note follows its text and still takes R after lines are inserted above it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reanchor-"));
    const left = join(dir, "before.txt");
    const right = join(dir, "after.txt");
    writeFileSync(left, lines("a", "b", "c", "d", "e"));
    writeFileSync(right, lines("a", "b", "c2", "d", "e"));
    const { dispatchCommand, hostClient } = createMockHostClient();
    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "unified", cursorLine: "row", agentNotes: true },
    });
    const rendered = await testRender(
      <AppHost bootstrap={bootstrap} hostClient={hostClient} />,
      WIDE,
    );
    setup = rendered;
    try {
      await flush(rendered);
      await act(async () => {
        await dispatchCommand({
          type: "command",
          requestId: "comment-1",
          command: "comment",
          input: {
            sessionId: "session-1",
            filePath: "after.txt",
            side: "new",
            line: 3,
            summary: "About c2",
          },
        });
      });
      await flush(rendered);
      expect(rendered.captureCharFrame()).toContain("About c2");

      // The reviewer edits the file in $EDITOR: two lines go in above everything.
      writeFileSync(right, lines("zero", "one", "a", "b", "c2", "d", "e"));
      await act(async () => {
        await dispatchCommand({
          type: "command",
          requestId: "reload-1",
          command: "reload_session",
          input: {
            sessionId: "session-1",
            nextInput: {
              kind: "diff",
              left,
              right,
              options: { mode: "unified", cursorLine: "row", agentNotes: true },
            },
          },
        });
      });
      let frame = rendered.captureCharFrame();
      for (let attempt = 0; attempt < 10 && !frame.includes("zero"); attempt += 1) {
        await act(async () => {
          await Bun.sleep(30);
          await rendered.renderOnce();
        });
        frame = rendered.captureCharFrame();
      }
      const rows = frame.split("\n");
      const noteRow = rows.findIndex((row) => row.includes("About c2"));
      const c2Row = rows.findIndex((row) => row.includes("+  c2"));
      expect(c2Row).toBeGreaterThan(0);
      expect(noteRow).toBeGreaterThan(c2Row);
      expect(noteRow - c2Row).toBeLessThan(5);
      expect(rows[noteRow - 2]).toContain("R5");

      // Step down until the note card takes focus, then reply from the keyboard.
      let replied = false;
      for (let i = 0; i < 9 && !replied; i += 1) {
        await press(rendered, "j");
        await press(rendered, "R");
        replied = rendered.captureCharFrame().includes("Write a note");
      }
      expect(replied).toBe(true);
      frame = rendered.captureCharFrame();
      const replyRows = frame.split("\n");
      const replyRow = replyRows.findIndex((row) => row.includes("Reply - "));
      const noteEnd = replyRows.findIndex((row, index) => index > noteRow && row.includes("╯"));
      expect(replyRow).toBe(noteEnd + 1);
      expect(frame).toContain("Write a note");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
