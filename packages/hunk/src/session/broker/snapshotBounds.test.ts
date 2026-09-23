import { describe, expect, test } from "bun:test";
import { MAX_BROKER_STRING_BYTES } from "@hunk/session-broker-core";
import { createTestSessionSnapshot } from "../../../../../test/helpers/session-daemon-fixtures";
import { boundHunkSessionSnapshot, clipToWireBytes } from "./snapshotBounds";
import { diagnoseSessionSnapshot } from "./wire";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("clipToWireBytes", () => {
  test("returns a string within the ceiling unchanged", () => {
    const value = "x".repeat(MAX_BROKER_STRING_BYTES);
    expect(clipToWireBytes(value)).toBe(value);
  });

  test("clips an over-long string to the ceiling and marks the cut", () => {
    const clipped = clipToWireBytes("x".repeat(MAX_BROKER_STRING_BYTES + 1));
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(MAX_BROKER_STRING_BYTES);
    expect(clipped.endsWith("…")).toBe(true);
  });

  test("never splits a multi-byte character", () => {
    // Each "é" is two bytes; a ceiling of 7 leaves 4 bytes for text after the 3-byte marker.
    const clipped = clipToWireBytes("ééééé", 7);
    expect(clipped).toBe("éé…");
    expect(utf8Bytes(clipped)).toBe(7);
  });
});

describe("boundHunkSessionSnapshot", () => {
  // Intent: the reproduced session drop — a reviewer note over the wire ceiling took the whole
  // session down because the daemon refused every snapshot and every re-registration carrying it.
  test("a snapshot with an over-long note passes the daemon's wire parser after bounding", () => {
    const snapshot = createTestSessionSnapshot({
      reviewNotes: [
        {
          noteId: "user:1",
          source: "user",
          filePath: "src/example.ts",
          hunkIndex: 0,
          newRange: [2, 2],
          body: "y".repeat(5_000),
          author: "user",
          createdAt: "2026-03-22T00:00:00.000Z",
          editable: true,
        },
      ],
      reviewNoteCount: 1,
    });
    expect(diagnoseSessionSnapshot(snapshot)).not.toBeNull();

    const bounded = boundHunkSessionSnapshot(snapshot);

    expect(diagnoseSessionSnapshot(bounded)).toBeNull();
    const body = bounded.state.reviewNotes?.[0]?.body ?? "";
    expect(utf8Bytes(body)).toBeLessThanOrEqual(MAX_BROKER_STRING_BYTES);
    expect(body.endsWith("…")).toBe(true);
  });

  test("clips live comment summaries and rationales", () => {
    const snapshot = createTestSessionSnapshot({
      liveComments: [
        {
          commentId: "mcp:1",
          filePath: "src/example.ts",
          hunkIndex: 0,
          side: "new",
          line: 2,
          summary: "s".repeat(5_000),
          rationale: "r".repeat(5_000),
          createdAt: "2026-03-22T00:00:00.000Z",
        },
      ],
      liveCommentCount: 1,
    });

    const bounded = boundHunkSessionSnapshot(snapshot);

    expect(diagnoseSessionSnapshot(bounded)).toBeNull();
    const comment = bounded.state.liveComments[0]!;
    expect(utf8Bytes(comment.summary)).toBeLessThanOrEqual(MAX_BROKER_STRING_BYTES);
    expect(utf8Bytes(comment.rationale ?? "")).toBeLessThanOrEqual(MAX_BROKER_STRING_BYTES);
  });

  test("replaces an empty required text and omits an empty optional one", () => {
    const snapshot = createTestSessionSnapshot({
      liveComments: [
        {
          commentId: "mcp:1",
          filePath: "src/example.ts",
          hunkIndex: 0,
          side: "new",
          line: 2,
          summary: "",
          rationale: "",
          author: "",
          createdAt: "2026-03-22T00:00:00.000Z",
        },
      ],
      liveCommentCount: 1,
    });
    expect(diagnoseSessionSnapshot(snapshot)).not.toBeNull();

    const bounded = boundHunkSessionSnapshot(snapshot);

    expect(diagnoseSessionSnapshot(bounded)).toBeNull();
    expect(bounded.state.liveComments[0]).toEqual({
      commentId: "mcp:1",
      filePath: "src/example.ts",
      hunkIndex: 0,
      side: "new",
      line: 2,
      summary: "(empty)",
      createdAt: "2026-03-22T00:00:00.000Z",
    });
  });

  // Intent: a reload that retires a file keeps that file's notes in the window's store but
  // drops them from the summaries; a count taken from the store then fails the daemon's
  // equality check and every later snapshot is refused until the notes are removed.
  test("restates the note counts from the arrays so a retired note cannot skew them", () => {
    const snapshot = createTestSessionSnapshot({
      liveComments: [
        {
          commentId: "mcp:1",
          filePath: "src/example.ts",
          hunkIndex: 0,
          side: "new",
          line: 2,
          summary: "kept",
          createdAt: "2026-03-22T00:00:00.000Z",
        },
      ],
      liveCommentCount: 3,
      reviewNotes: [],
      reviewNoteCount: 2,
    });

    expect(diagnoseSessionSnapshot(snapshot)).not.toBeNull();
    const bounded = boundHunkSessionSnapshot(snapshot);
    expect(diagnoseSessionSnapshot(bounded)).toBeNull();
    expect(bounded.state.liveCommentCount).toBe(1);
    expect(bounded.state.reviewNoteCount).toBe(0);
  });

  test("leaves an in-bounds snapshot equal to itself", () => {
    const snapshot = createTestSessionSnapshot({
      reviewNotes: [
        {
          noteId: "user:1",
          source: "user",
          filePath: "src/example.ts",
          body: "short",
          createdAt: "2026-03-22T00:00:00.000Z",
          editable: true,
        },
      ],
      reviewNoteCount: 1,
    });

    expect(boundHunkSessionSnapshot(snapshot)).toEqual(snapshot);
  });
});
