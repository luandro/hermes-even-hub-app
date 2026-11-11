import { describe, it, expect, vi } from "vitest";
import { getTextWidth } from "@evenrealities/pretext";
import { listRows, buildListView, loadingText, renderList, renderSession } from "../src/ui/views";
import { initialState, type AppState, type Prompt } from "../src/state/store";
import { THREAD_BODY_INNER_WIDTH, THREAD_VIEWPORT_LINES } from "../src/ui/stream";

describe("buildListView", () => {
  it("derives rows and ids from one filtered array: row i ↔ ids[i], foreign hidden", () => {
    const s: AppState = {
      ...initialState(),
      sessionsLoaded: true,
      sessions: {
        items: [
          { id: "tg-1", title: "Telegram chat", updated: 900, foreign: true },
          { id: "ro-1", title: "Read-only chat", updated: 800, read_only: true },
          { id: "own-2", title: "second own", updated: 300 },
          { id: "own-1", title: "first own", updated: 100 },
        ],
        active: "own-2",
      },
    };
    const view = buildListView(s, 400);
    expect(view.ids).toEqual([null, "own-2", "own-1"]);
    expect(view.rows).toHaveLength(3);
    expect(view.rows[1]).toContain("second own");
    expect(view.rows[1]).toContain("●"); // active marker survives filtering
    expect(view.rows.some((r) => r.includes("Telegram") || r.includes("Read-only"))).toBe(false);
  });

  it("shows exactly ＋New plus the 3 own rows for a 12-foreign + 3-own fixture", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `tg-${i}`, title: `tg ${i}`, updated: 1000 + i, foreign: true })),
      { id: "own-a", title: "own a", updated: 5 },
      { id: "own-b", title: "own b", updated: 3 },
      { id: "own-c", title: "own c", updated: 1 },
    ];
    const view = buildListView(
      { ...initialState(), sessionsLoaded: true, sessions: { items, active: null } },
      10,
    );
    expect(view.rows).toHaveLength(4);
    expect(view.rows[0]).toBe("＋ New session");
    expect(view.ids).toEqual([null, "own-a", "own-b", "own-c"]);
  });
});

describe("listRows", () => {
  it("shows a non-actionable loading row until sessions hydrate", () => {
    expect(listRows(initialState())).toEqual(["loading sessions..."]);
  });

  it("prepends the ＋New row and sorts sessions newest-first", () => {
    const now = 200_000;
    const s: AppState = {
      ...initialState(),
      sessionsLoaded: true,
      sessions: {
        items: [
          { id: "old", title: "refactor parser", updated: now - 86_400 },
          { id: "new", title: "build the app", updated: now - 7200 },
        ],
        active: "new",
      },
    };
    expect(listRows(s, now)).toEqual([
      "＋ New session",
      "● 2h build the app",
      "  1d refactor parser",
    ]);
  });

  it("keeps server order when timestamps are equal", () => {
    const s: AppState = {
      ...initialState(),
      sessionsLoaded: true,
      sessions: {
        items: [
          { id: "a", title: "first", updated: 1 },
          { id: "b", title: "second", updated: 1 },
        ],
        active: null,
      },
    };
    expect(listRows(s, 1).slice(1)).toEqual(["  now first", "  now second"]);
  });

  it("uses a stable new-session fallback for untitled sessions", () => {
    const s: AppState = { ...initialState(), sessionsLoaded: true, sessions: { items: [{ id: "a", title: "   ", updated: 0 }], active: null } };
    expect(listRows(s, 1)).toEqual(["＋ New session", "  -- New session a"]);
  });

  it("truncates long rows to fit the native list width", () => {
    const s: AppState = {
      ...initialState(),
      sessionsLoaded: true,
      sessions: { items: [{ id: "a", title: "W".repeat(80), updated: 1 }], active: "a" },
    };
    const row = listRows(s, 1)[1];
    expect(row.endsWith("…")).toBe(true);
    expect(row.length).toBeLessThanOrEqual(64);
    expect(getTextWidth(row)).toBeLessThanOrEqual(576);
  });
});

describe("renderList", () => {
  it("renders loading as a text page until sessions hydrate", async () => {
    const bridge = { rebuildPageContainer: vi.fn(async () => {}) } as any;
    await renderList(bridge, { ...initialState(), conn: "connected" });
    const arg = bridge.rebuildPageContainer.mock.calls[0][0];
    expect(arg.listObject).toBeUndefined();
    expect(arg.textObject[0].content).toBe("loading sessions...\nwaiting for session list");
  });

  it("renders a native list after sessions hydrate", async () => {
    const bridge = { rebuildPageContainer: vi.fn(async () => {}) } as any;
    await renderList(bridge, {
      ...initialState(),
      sessionsLoaded: true,
      sessions: { items: [{ id: "a", title: "A", updated: 1 }], active: null },
    });
    const arg = bridge.rebuildPageContainer.mock.calls[0][0];
    expect(arg.textObject).toBeUndefined();
    expect(arg.listObject[0].itemContainer.itemName[0]).toBe("＋ New session");
  });

  it("includes connection status in loading text", () => {
    expect(loadingText({ ...initialState(), conn: "reconnecting" })).toBe("loading sessions...\nreconnecting");
  });
});

describe("renderSession", () => {
  it("fills header (title+dot), body (stream), status (bar)", async () => {
    const calls: Record<number, string> = {};
    const bridge = {
      textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }),
    } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected", turn: "idle",
      sessions: { items: [{ id: "a", title: "build the app", updated: 0 }], active: "a" },
      stream: [{ kind: "user", text: "hi" }],
    };
    await renderSession(bridge, s);
    expect(calls[1]).toBe("build the app");      // IDS.header (title only)
    expect(calls[5]).toBe("●");                   // IDS.dot (far-right)
    expect(calls[2]).toBe("> hi");                // IDS.body
    expect(calls[3]).toBe("ready");               // IDS.status
  });
  it("falls back to the first user message when the session is untitled", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "   ", updated: 0 }], active: "a" },
      stream: [{ kind: "banner", text: "model: x" }, { kind: "user", text: "how do I fold an omelette" }],
    };
    await renderSession(bridge, s);
    expect(calls[1]).toBe("how do I fold an omelette");
  });
  it("treats a literal 'New session' title as untitled", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "New session", updated: 0 }], active: "a" },
      stream: [{ kind: "user", text: "ligar o ventilador" }],
    };
    await renderSession(bridge, s);
    expect(calls[1]).toBe("ligar o ventilador");
  });
  it("truncates the fallback snippet to the header width", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "", updated: 0 }], active: "a" },
      stream: [{ kind: "user", text: "w".repeat(120) }],
    };
    await renderSession(bridge, s);
    expect(calls[1].endsWith("…")).toBe(true);
    expect(calls[1].length).toBeLessThanOrEqual(64);
    expect(getTextWidth(calls[1])).toBeLessThanOrEqual(540);
  });
  it("keeps 'Hermes' when untitled and no user message exists", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "", updated: 0 }], active: "a" },
      stream: [{ kind: "banner", text: "model: x" }],
    };
    await renderSession(bridge, s);
    expect(calls[1]).toBe("Hermes");
  });
  it("shows loading text while session history is in flight", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" },
      history: { loadingFor: "a", failedFor: null },
    };
    await renderSession(bridge, s);
    expect(calls[2]).toBe("loading session...");
    expect(calls[3]).toBe("loading session...");
  });
  it("keeps an empty failed-history session usable", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" },
      history: { loadingFor: null, failedFor: "a" },
    };
    await renderSession(bridge, s);
    expect(calls[2]).toBe("tap to speak");
    expect(calls[3]).toBe("history unavailable");
  });
  it("renders honest banner instead of tap to speak for readonly session without history", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "tg-1", title: "🔒 TG", updated: 0, read_only: true }], active: "tg-1" },
      history: { loadingFor: null, failedFor: null },
      readonlyNoHistory: true,
      stream: [],
    };
    await renderSession(bridge, s);
    expect(calls[2]).toBe("");
    expect(calls[3]).toBe("History not shown (Telegram-owned session, read-only)");
  });
  it("shows the pending transcript as the next user line during review", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = { ...initialState(), screen: "session", phase: "review", conn: "connected",
      sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" }, pending: { transcript: "add dark mode" } };
    await renderSession(bridge, s);
    expect(calls[2]).toBe("> add dark mode");
    expect(calls[3]).toBe("tap = send · swipe↓ = discard");
  });
  it("keeps the thread visible behind a pending transcript", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = {
      ...initialState(), screen: "session", phase: "review", conn: "connected",
      sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" },
      stream: [{ kind: "user", text: "hi" }, { kind: "assistant", text: "Hello." }],
      pending: { transcript: "add dark mode" },
    };
    await renderSession(bridge, s);
    expect(calls[2]).toBe("> hi\nHello.\n> add dark mode");
  });
  it("renders the held page when scrollPage is an absolute index", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const big = "x".repeat(800); // multiple measured viewport windows
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" },
      stream: [{ kind: "user", text: "hi" }, { kind: "assistant", text: big }],
      scrollPage: 0,
    };
    const { threadPages } = await import("../src/ui/stream");
    await renderSession(bridge, s);
    expect(calls[2]).toBe(threadPages(s.stream)[0]); // IDS.body shows page 0
  });
  it("adds viewport position to the status line for long threads", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const big = "x".repeat(800);
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle", conn: "connected",
      sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" },
      stream: [{ kind: "user", text: "hi" }, { kind: "assistant", text: big }],
      scrollPage: 0,
    };
    const { threadPages } = await import("../src/ui/stream");
    await renderSession(bridge, s);
    expect(calls[3]).toBe(`ready · 1/${threadPages(s.stream).length}`);
  });
});

function prompt(overrides?: Partial<Prompt>): Prompt {
  return {
    id: "p1",
    kind: "exec_approval",
    title: "Approve?",
    command: "rm -rf /tmp/x",
    description: "shell",
    options: [
      { id: "once", label: "Approve once", style: "primary" },
      { id: "deny", label: "Deny", style: "danger", default: true },
    ],
    timeout_s: 0,
    timeout_choice: null,
    ...overrides,
  };
}

function prompted(p: Prompt, promptHighlight = 1): AppState {
  return {
    ...initialState(), screen: "session", phase: "idle", conn: "connected",
    sessions: { items: [{ id: "a", title: "A", updated: 0 }], active: "a" },
    prompts: [p], promptHighlight,
  };
}

describe("renderSession: prompt panel (A6/A11)", () => {
  it("title to header, command + wire-order options to body, marker on the highlighted row", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    await renderSession(bridge, prompted(prompt()));
    expect(calls[1]).toBe("Approve?"); // IDS.header: the prompt title
    expect(calls[2]).toBe("rm -rf /tmp/x\n  Approve once\n> Deny"); // IDS.body
  });
  it("the marker follows the highlight, not the wire order", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    await renderSession(bridge, prompted(prompt(), 0));
    expect(calls[2]).toBe("rm -rf /tmp/x\n> Approve once\n  Deny");
  });
  it("2 and 6 options both fit the G2 text container", async () => {
    for (const n of [2, 6]) {
      const calls: Record<number, string> = {};
      const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
      const options = Array.from({ length: n }, (_, i) => ({
        id: `o${i}`,
        label: `Option ${i}`,
        style: i === 0 ? "primary" as const : "",
        ...(i === 1 ? { default: true } : {}),
      }));
      await renderSession(bridge, prompted(prompt({ options, command: "python3 -m http.server 8080 --directory /var/www --bind 127.0.0.1" })));
      const lines = calls[2].split("\n");
      expect(lines.length, `${n} options`).toBeLessThanOrEqual(THREAD_VIEWPORT_LINES);
      expect(lines.some((l) => l.includes(`Option ${n - 1}`)), `${n} options rendered`).toBe(true);
      for (const line of lines) {
        expect(getTextWidth(line), `${n} options: ${line}`).toBeLessThanOrEqual(THREAD_BODY_INNER_WIDTH);
      }
    }
  });
  it("defensively truncates option labels at 24 chars", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const long = "L".repeat(30);
    await renderSession(bridge, prompted(prompt({
      options: [
        { id: "once", label: long, style: "primary" },
        { id: "deny", label: "Deny", style: "danger", default: true },
      ],
    })));
    const lines = calls[2].split("\n");
    expect(lines[1].trim()).toBe("L".repeat(24));
    expect(lines[1].length).toBeLessThanOrEqual(24 + 2);
  });
  it("with no timer the hint promises 'no answer = no'", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    await renderSession(bridge, prompted(prompt()));
    expect(calls[3]).toBe("scroll=choose · tap=ok · 2×tap=Deny · no answer = no");
  });
  it("with a timer the hint names the auto choice and the seconds", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    await renderSession(bridge, prompted(prompt({ timeout_s: 15, timeout_choice: "once" })));
    expect(calls[3]).toBe("scroll=choose · tap=ok · 2×tap=Deny · auto Approve once 15s");
  });
  it("appends +N when more prompts are queued", async () => {
    const calls: Record<number, string> = {};
    const bridge = { textContainerUpgrade: vi.fn(async (u: any) => { calls[u.containerID] = u.content; }) } as any;
    const s: AppState = { ...prompted(prompt()), prompts: [prompt(), prompt({ id: "p2" }), prompt({ id: "p3" })] };
    await renderSession(bridge, s);
    expect(calls[3]).toBe("scroll=choose · tap=ok · 2×tap=Deny · no answer = no · +2");
  });
});
