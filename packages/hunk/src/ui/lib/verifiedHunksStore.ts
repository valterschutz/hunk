/**
 * Persists the identities of the hunks the reviewer has verified.
 *
 * The store is a plain text file with one identity per line, so any file syncing tool
 * carries the list between machines without extra setup; the file is re-read before
 * every write so entries added elsewhere in the meantime survive. Writes go through a
 * rename, so a sync tool never sees a half-written file. An unconfigured path disables
 * the store: it is then always empty and cannot be written to.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHomePath } from "../../extensions/discovery";

export interface VerifiedHunksStore {
  /** Whether a file is configured, and so whether `toggle` may be called. */
  readonly enabled: boolean;
  /** Read the stored identities; a file that does not exist yet is an empty store. */
  load(): ReadonlySet<string>;
  /** Add the identity, or remove it when it is already stored, and return the new set. */
  toggle(identity: string): ReadonlySet<string>;
}

/** Read the file's identities, treating a missing file as empty. */
function readIdentities(path: string): Set<string> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  const identities = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      identities.add(trimmed);
    }
  }
  return identities;
}

/** Write the identities sorted, so the file only changes when the set does. */
function writeIdentities(path: string, identities: ReadonlySet<string>) {
  const lines = [...identities].toSorted();
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, path);
}

/** Build the store behind one configured path; undefined or empty disables it. */
export function createVerifiedHunksStore(configuredPath: string | undefined): VerifiedHunksStore {
  const path =
    configuredPath && configuredPath.length > 0 ? expandHomePath(configuredPath) : undefined;
  return {
    enabled: path !== undefined,
    load() {
      return path === undefined ? new Set() : readIdentities(path);
    },
    toggle(identity) {
      if (path === undefined) {
        throw new Error("Cannot toggle a verified hunk without a configured verified_hunks_file");
      }
      if (identity.length === 0 || /\s/.test(identity)) {
        throw new Error(`Invalid verified hunk identity ${JSON.stringify(identity)}`);
      }
      const identities = readIdentities(path);
      if (identities.has(identity)) {
        identities.delete(identity);
      } else {
        identities.add(identity);
      }
      writeIdentities(path, identities);
      return identities;
    },
  };
}
