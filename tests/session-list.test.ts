import { describe, expect, it } from "vitest";
import {
  NEW_SESSION_ROW,
  isOwnSession,
  listableSessions,
  pickResumeSession,
  sessionForListIndex,
  sessionListRows,
} from "../src/ui/session-list";
import type { SessionItem } from "../src/protocol";

const utf8 = new TextEncoder();

const own = (id: string, updated = 1): SessionItem => ({ id, title: `chat ${id}`, updated });
const foreign = (id: string, updated = 1): SessionItem => ({ id, title: `tg ${id}`, updated, foreign: true, platform: "telegram" });
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
  it("keeps every non-read-only row (resumable foreign included), newest first", () => {
    const items = [foreign("f1", 900), own("old", 100), readOnly("r1", 800), own("new", 300)];
    expect(listableSessions(items).map((i) => i.id)).toEqual(["f1", "new", "old"]);
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

  it("shows resumable foreign rows with an ASCII origin tag; read-only stay hidden", () => {
    const rows = sessionListRows([own("a", 1), foreign("f", 2), readOnly("r", 3)], null, 1);
    expect(rows).toEqual([NEW_SESSION_ROW, "  now [TG] tg f", "  now chat a"]);
  });

  it("shows exactly ＋New plus tagged foreign rows and own rows for a realistic mixed fixture", () => {
    const items: SessionItem[] = [
      ...Array.from({ length: 12 }, (_, i) => foreign(`tg-${i}`, 1000 + i)),
      own("own-1", 5),
      own("own-2", 3),
      own("own-3", 1),
    ];
    const rows = sessionListRows(items, "own-2", 10);

    expect(rows).toHaveLength(16);
    expect(rows[0]).toBe(NEW_SESSION_ROW);
    expect(rows[1]).toBe("  now [TG] tg tg-11"); // newest foreign first, tagged
    expect(rows[13]).toBe("  now chat own-1"); // newest own after the foreign rows
    expect(rows[14]).toBe("● now chat own-2"); // active marker survives filtering
    expect(rows.every((row) => utf8.encode(row).length <= 63)).toBe(true);
  });
});

describe("formatSessionRow origin tags", () => {
  const tagged = (item: SessionItem, active: string | null = null): string =>
    sessionListRows([item], active, 1)[1];

  it("prefixes telegram rows with [TG]", () => {
    expect(tagged({ ...foreign("f", 1), platform: "telegram" })).toBe("  now [TG] tg f");
  });
  it("prefixes other foreign platforms with [EXT]", () => {
    expect(tagged({ ...foreign("f", 1), platform: "web" })).toBe("  now [EXT] tg f");
  });
  it("strips a leading lock glyph before tagging (firmware drops emoji)", () => {
    expect(tagged({ ...foreign("f", 1), platform: "telegram", title: "🔒 Deploy debug" }))
      .toBe("  now [TG] Deploy debug");
  });
  it("strips a leading lock glyph from own rows too and leaves them untagged", () => {
    expect(tagged({ ...own("a", 1), title: "🔒 Locked own" })).toBe("  now Locked own");
  });
});

describe("mirror leg merge (V3.1 W3): one row per live-linked conversation", () => {
  // The observed bug: after a Telegram turn the paired [TG] leg surfaces as
  // its own newer row above the glasses row of the SAME conversation.
  const g2Leg: SessionItem = {
    id: "g2-1", title: "Connectivity ping check", updated: 100,
    conversation_id: "conv-1",
  };
  const tgLeg: SessionItem = {
    id: "tg-1", title: "Connectivity ping check", updated: 900,
    conversation_id: "conv-1", foreign: true, platform: "telegram",
  };
  const map = { "conv-1": "g2-1" }; // learned from the mirror frame's cid
  const unmergedRows = [
    NEW_SESSION_ROW,
    "  now [TG] Connectivity ping check", // tg leg (900) is newer → on top
    "● 13m Connectivity ping check", // the glasses leg itself
  ];

  it("merges rows with the same learned cid into one, titled by the receiving leg", () => {
    expect(sessionListRows([tgLeg, g2Leg], "g2-1", 900, map)).toEqual([
      NEW_SESSION_ROW,
      "● now Connectivity ping check",
    ]);
  });

  it("without a learned cid (frame without cid / older bridge) rows are exactly as today", () => {
    expect(sessionListRows([tgLeg, g2Leg], "g2-1", 900)).toEqual(unmergedRows);
    expect(sessionListRows([tgLeg, g2Leg], "g2-1", 900, {})).toEqual(unmergedRows);
  });

  it("a learned cid matching no row changes nothing", () => {
    expect(sessionListRows([tgLeg, g2Leg], "g2-1", 900, { "conv-9": "g2-9" }))
      .toEqual(unmergedRows);
  });

  it("a cid whose receiving row is absent from the list merges nothing", () => {
    expect(sessionListRows([tgLeg, g2Leg], "g2-1", 900, { "conv-1": "g2-gone" }))
      .toEqual(unmergedRows);
  });

  it("rows sharing a conversation_id that was never mirror-learned stay separate (V2 handoff)", () => {
    // A handoff pair shares conversation_id without a live link: no mirror
    // frame ever named that cid, so the rows must NOT merge.
    const child: SessionItem = { id: "child-1", title: "Forked", updated: 50, conversation_id: "conv-2" };
    const parent: SessionItem = { id: "parent-1", title: "Original", updated: 900, conversation_id: "conv-2" };
    expect(listableSessions([child, parent]).map((i) => i.id))
      .toEqual(["parent-1", "child-1"]);
  });

  it("the merged row sorts by the conversation's latest activity", () => {
    const other: SessionItem = { id: "other", title: "Other", updated: 500 };
    expect(listableSessions([g2Leg, tgLeg, other], map).map((i) => i.id))
      .toEqual(["g2-1", "other"]); // merged row carries updated=900 from the tg leg
  });

  it("tapping the merged row opens the receiving leg (row→id mapping stays consistent)", () => {
    expect(listableSessions([tgLeg, g2Leg], map).map((i) => i.id)).toEqual(["g2-1"]);
    expect(sessionForListIndex([tgLeg, g2Leg], 1, map)?.id).toBe("g2-1");
    // and without the map the mapping is today's two-row mapping
    expect(sessionForListIndex([tgLeg, g2Leg], 1)?.id).toBe("tg-1");
    expect(sessionForListIndex([tgLeg, g2Leg], 2)?.id).toBe("g2-1");
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
