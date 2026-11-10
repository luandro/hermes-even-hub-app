import { describe, expect, it } from "vitest";
import {
  NEW_SESSION_ROW,
  isOwnSession,
  listableSessions,
  pickResumeSession,
  sessionListRows,
} from "../src/ui/session-list";
import type { SessionItem } from "../src/protocol";

const utf8 = new TextEncoder();

const own = (id: string, updated = 1): SessionItem => ({ id, title: `chat ${id}`, updated });
const foreign = (id: string, updated = 1): SessionItem => ({ id, title: `tg ${id}`, updated, foreign: true });
const readOnly = (id: string, updated = 1): SessionItem => ({ id, title: `ro ${id}`, updated, read_only: true });

describe("isOwnSession", () => {
  it("accepts a plain G2 session", () => {
    expect(isOwnSession(own("a"))).toBe(true);
  });
  it("rejects foreign (Telegram) sessions", () => {
    expect(isOwnSession(foreign("a"))).toBe(false);
  });
  it("rejects read-only sessions", () => {
    expect(isOwnSession(readOnly("a"))).toBe(false);
  });
  it("rejects a session that is both foreign and read-only", () => {
    expect(isOwnSession({ ...own("a"), foreign: true, read_only: true })).toBe(false);
  });
});

describe("listableSessions", () => {
  it("keeps only own sessions, newest first", () => {
    const items = [foreign("f1", 900), own("old", 100), readOnly("r1", 800), own("new", 300)];
    expect(listableSessions(items).map((i) => i.id)).toEqual(["new", "old"]);
  });
});

describe("sessionListRows", () => {
  it("keeps same-age untitled sessions visually distinct", () => {
    const rows = sessionListRows([
      { id: "20260603_214928_c173a316", title: "New session", updated: 1_780_000_000 },
      { id: "20260603_214450_6b8e5adb", title: "New session", updated: 1_780_000_000 },
    ], null, 1_780_000_000);

    expect(rows.slice(1)).toEqual([
      "  now New session a316",
      "  now New session 5adb",
    ]);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("keeps every rendered row within the firmware byte limit", () => {
    const rows = sessionListRows([
      {
        id: "long",
        title: "A very long session title with multibyte symbols ●＋ and enough text to overflow the list item byte validator",
        updated: 1_780_000_000,
      },
    ], "long", 1_780_000_030);

    expect(rows.every((row) => utf8.encode(row).length <= 63)).toBe(true);
  });

  it("hides foreign and read-only sessions entirely", () => {
    const rows = sessionListRows([own("a", 1), foreign("f", 2), readOnly("r", 3)], null, 1);
    expect(rows).toEqual([NEW_SESSION_ROW, "  now chat a"]);
  });

  it("shows exactly ＋New plus the own rows for a realistic mixed fixture", () => {
    const items: SessionItem[] = [
      ...Array.from({ length: 12 }, (_, i) => foreign(`tg-${i}`, 1000 + i)),
      own("own-1", 5),
      own("own-2", 3),
      own("own-3", 1),
    ];
    const rows = sessionListRows(items, "own-2", 10);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe(NEW_SESSION_ROW);
    expect(rows.some((r) => r.includes("tg-"))).toBe(false);
    expect(rows[1]).toBe("  now chat own-1"); // newest own first
    expect(rows[2]).toBe("● now chat own-2"); // active marker survives filtering
  });
});

describe("pickResumeSession", () => {
  const items: SessionItem[] = [foreign("f", 900), readOnly("r", 800), own("new", 300), own("old", 100)];

  it("prefers the bridge-reported active id when it is own", () => {
    expect(pickResumeSession(items, "old", "new")).toBe("old");
  });
  it("falls back to the persisted id when the bridge active id is foreign", () => {
    expect(pickResumeSession(items, "f", "old")).toBe("old");
  });
  it("falls back to the persisted id when the bridge reports no active session", () => {
    expect(pickResumeSession(items, null, "old")).toBe("old");
  });
  it("ignores a persisted foreign, read-only, or unknown id", () => {
    expect(pickResumeSession(items, null, "f")).toBe("new");
    expect(pickResumeSession(items, null, "r")).toBe("new");
    expect(pickResumeSession(items, null, "missing")).toBe("new");
    expect(pickResumeSession(items, null, null)).toBe("new");
  });
  it("returns null when no own session exists (caller creates one)", () => {
    expect(pickResumeSession([foreign("f"), readOnly("r")], null, "f")).toBeNull();
    expect(pickResumeSession([], null, null)).toBeNull();
  });
});
