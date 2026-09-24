import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createVerifiedHunksStore } from "./verifiedHunksStore";

const tempDirs: string[] = [];

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-verified-hunks-"));
  tempDirs.push(dir);
  return join(dir, "nested", "verified-hunks");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("createVerifiedHunksStore", () => {
  test("an unconfigured store is disabled, empty, and refuses to toggle", () => {
    for (const configured of [undefined, ""]) {
      const store = createVerifiedHunksStore(configured);
      expect(store.enabled).toBe(false);
      expect(store.load().size).toBe(0);
      expect(() => store.toggle("abc")).toThrow(/verified_hunks_file/);
    }
  });

  test("a missing file loads as empty and toggling creates it with its directory", () => {
    const path = tempPath();
    const store = createVerifiedHunksStore(path);

    expect(store.enabled).toBe(true);
    expect(store.load().size).toBe(0);
    expect([...store.toggle("bbb")]).toEqual(["bbb"]);
    expect(readFileSync(path, "utf8")).toBe("bbb\n");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("toggling adds, then removes, and writes the identities sorted", () => {
    const path = tempPath();
    const store = createVerifiedHunksStore(path);

    store.toggle("bbb");
    expect([...store.toggle("aaa")].toSorted()).toEqual(["aaa", "bbb"]);
    expect(readFileSync(path, "utf8")).toBe("aaa\nbbb\n");
    expect([...store.toggle("bbb")]).toEqual(["aaa"]);
    expect(readFileSync(path, "utf8")).toBe("aaa\n");
    expect([...store.toggle("aaa")]).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  test("keeps identities another writer added since the last load", () => {
    const path = tempPath();
    const store = createVerifiedHunksStore(path);
    store.toggle("aaa");
    writeFileSync(path, "aaa\nsynced\n\n  \n");

    expect([...store.toggle("bbb")].toSorted()).toEqual(["aaa", "bbb", "synced"]);
    expect([...store.load()].toSorted()).toEqual(["aaa", "bbb", "synced"]);
  });

  test("rejects an identity that would not survive the one-per-line format", () => {
    const store = createVerifiedHunksStore(tempPath());
    expect(() => store.toggle("")).toThrow(/Invalid/);
    expect(() => store.toggle("a b")).toThrow(/Invalid/);
  });

  test("expands a leading ~ to the home directory", () => {
    const path = tempPath();
    const configured = `~/${relative(homedir(), path).split("\\").join("/")}`;
    if (configured.startsWith("~/..")) {
      // The temp dir is outside the home directory on this machine, so ~ cannot reach it.
      return;
    }
    const store = createVerifiedHunksStore(configured);
    store.toggle("aaa");
    expect(readFileSync(path, "utf8")).toBe("aaa\n");
  });
});
