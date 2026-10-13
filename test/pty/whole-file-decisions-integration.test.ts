import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
setDefaultTimeout(30_000);
afterEach(() => harness.cleanup());

/** Read the persisted decisions rather than inferring action safety from rendered notices. */
function readTestDecisions(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.kind === "hunk");
}

test("whole-file context retains decided changes while navigation and decision keys skip them", async () => {
  const configHome = harness.createIsolatedConfigHome();
  const reviewFile = join(configHome, "review.jsonl");
  mkdirSync(join(configHome, "hunk"), { recursive: true });
  writeFileSync(
    join(configHome, "hunk", "config.toml"),
    `review_file = ${JSON.stringify(reviewFile)}\nwhole_file = true\nprompt_save_view_preferences = false\n`,
  );
  const before = Array.from({ length: 20 }, (_, index) => `context ${index + 1}`).join("\n") + "\n";
  const fixture = harness.createGitRepoFixture([
    {
      path: "sample.ts",
      before,
      after: before
        .replace("context 3\n", "first change\nextra addition\n")
        .replace("context 15\n", "second change\n"),
    },
    { path: "other.ts", before: "alpha\nbeta\ngamma\n", after: "alpha\nother change\ngamma\n" },
  ]);
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "unified"],
    cwd: fixture.dir,
    cols: 160,
    rows: 50,
    env: { XDG_CONFIG_HOME: configHome },
  });
  try {
    await session.waitForText(/context 9/, { timeout: 15_000 });
    await harness.ensureKeyboardIsLive(session);
    // File order is alphabetical: finish other.ts first, then wrap to sample.ts.
    await harness.pressAndWaitForText(session, "+", /1 context/);
    expect(readTestDecisions(reviewFile)).toHaveLength(1);
    await harness.pressAndWaitForText(session, "+", /2 context/);
    expect(readTestDecisions(reviewFile)).toHaveLength(2);
    let frame = await session.text({ immediate: true });
    expect(frame).toContain("first change");
    expect(frame).toContain("extra addition");
    expect(frame).toContain("context 3");
    expect(frame).toContain("context 9");
    // The previous-hunk key cannot move to the decided first hunk.
    await session.press("[");
    await session.press("k");
    await harness.pressAndWaitForText(session, "+", /No eligible review target/);
    expect(readTestDecisions(reviewFile)).toHaveLength(2);
    await session.press("]");
    await harness.pressAndWaitForText(session, "+", /No undecided hunks/);
    expect(readTestDecisions(reviewFile)).toHaveLength(3);
    await session.press("+");
    await session.waitIdle({ timeout: 400 });
    expect(readTestDecisions(reviewFile)).toHaveLength(3);
    frame = await session.text({ immediate: true });
    expect(frame).toContain("first change");
    expect(frame).toContain("second change");
    expect(frame).toContain("other change");
  } finally {
    session.close();
  }
});
