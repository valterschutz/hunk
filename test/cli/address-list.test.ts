import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run the source CLI with captured output and an isolated configuration directory. */
async function runCapturedHunk(args: string[], configHome: string, cwd: string) {
  const proc = Bun.spawn(["bun", "run", join(process.cwd(), "packages/hunk/src/main.tsx"), "--", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
      XDG_CONFIG_HOME: configHome,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const HUNK_ID = "0123456789abcdef0123456789abcdef";

describe("hunk address --list", () => {
  test("reads review_file from the user config and lists the repo's rejections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-address-list-"));
    const repo = join(dir, "repo");
    mkdirSync(join(dir, "hunk"), { recursive: true });
    mkdirSync(repo);
    const reviewFile = join(dir, "review.jsonl");
    writeFileSync(join(dir, "hunk", "config.toml"), `review_file = "${reviewFile}"\n`);
    writeFileSync(
      reviewFile,
      `${JSON.stringify({
        kind: "hunk",
        id: HUNK_ID,
        repo,
        path: "a.txt",
        state: "rejected",
        oldStart: 1,
        newStart: 1,
        lines: [" one", "-two", "+three"],
      })}\n`,
    );
    try {
      const listed = await runCapturedHunk(["address", "--list", "--repo", repo], dir, repo);
      expect(listed.stderr).toBe("");
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toBe("a.txt:1  three\n");

      const json = await runCapturedHunk(["address", "--list", "--repo", repo, "--json"], dir, repo);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ repo, rejections: [{ hunk: { id: HUNK_ID } }] });

      const unconfigured = await runCapturedHunk(["address", "--list", "--repo", repo], join(dir, "empty"), repo);
      expect(unconfigured.exitCode).toBe(1);
      expect(unconfigured.stderr).toContain("review_file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
