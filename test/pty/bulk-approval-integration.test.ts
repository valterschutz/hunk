import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const extension = fileURLToPath(
  new URL("../../examples/extensions/bulk-approval/index.ts", import.meta.url),
);
setDefaultTimeout(30_000);
afterEach(() => harness.cleanup());

test("af approves a file, aa requires confirmation, and text input owns a", async () => {
  const configHome = harness.createIsolatedConfigHome();
  const reviewFile = join(configHome, "review.jsonl");
  mkdirSync(join(configHome, "hunk"), { recursive: true });
  writeFileSync(
    join(configHome, "hunk", "config.toml"),
    `review_file = ${JSON.stringify(reviewFile)}\nprompt_save_view_preferences = false\n[keybindings]\n"hunk.view.toggleAgentNotes" = false\n`,
  );
  const fixture = harness.createTwoFileRepoFixture();
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "unified", "--extension", extension],
    cwd: fixture.dir,
    cols: 140,
    rows: 30,
    env: { XDG_CONFIG_HOME: configHome },
  });
  try {
    await session.waitForText(/alpha\.ts/, { timeout: 15_000 });
    await harness.ensureKeyboardIsLive(session);
    await harness.pressAndWaitForText(session, "/", /search diff/);
    await session.type("af");
    await session.waitForText(/\/ af/);
    await harness.pressAndWaitForText(session, "escape", /search diff/);
    await session.press("escape");
    await harness.waitForSnapshot(session, (text) => !text.includes("/ search diff"), 5_000);
    await session.press("a");
    await harness.pressAndWaitForText(session, "f", /Approved 1 undecided/);
    expect(readFileSync(reviewFile, "utf8")).toContain('"state":"accepted"');
    const before = readFileSync(reviewFile, "utf8");
    await session.press("a");
    await harness.pressAndWaitForText(session, "a", /Approve entire review\?/);
    await harness.pressAndWaitForSnapshot(
      session,
      "n",
      (text) => !text.includes("Approve entire review?"),
      5_000,
    );
    expect(readFileSync(reviewFile, "utf8")).toBe(before);
    await session.press("a");
    await harness.pressAndWaitForText(session, "a", /Approve entire review\?/);
    await harness.pressAndWaitForSnapshot(
      session,
      "y",
      (text) => !text.includes("Approve entire review?"),
      5_000,
    );
    const records = readFileSync(reviewFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      records.filter((record) => record.kind === "hunk" && record.state === "accepted"),
    ).toHaveLength(2);
  } finally {
    session.close();
  }
});
