import { describe, it, expect } from "vitest";
import {
  initialState, reduce, barText, connDot, offlineNotice,
  applyDisconnected, HINTS,
  type AppState, type StreamItem,
} from "../src/state/store";

describe("initialState", () => {
  it("boots on the session list, idle, empty stream", () => {
    const s = initialState();
    expect(s.screen).toBe("list");
    expect(s.phase).toBe("idle");
    expect(s.stream).toEqual([]);
    expect(s.pending).toBeNull();
    expect(s.turn).toBe("idle");
    expect(s.sessions).toEqual({ items: [], active: null });
    expect(s.sessionsLoaded).toBe(false);
    expect(s.history).toEqual({ loadingFor: null, failedFor: null, refresh: false });
  });
});

describe("reduce: sessions", () => {
  it("sets items and active from a sessions message", () => {
    const s: AppState = initialState();
    const next = reduce(s, { t: "sessions", items: [{ id: "a", title: "A", updated: 1 }], active: "a" });
    expect(next.sessionsLoaded).toBe(true);
    expect(next.sessions.items).toHaveLength(1);
    expect(next.sessions.active).toBe("a");
  });
  it("does not let a late sessions frame steal active while history is loading", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: { items: [{ id: "old", title: "Old", updated: 1 }], active: "selected" },
      history: { loadingFor: "selected", failedFor: null },
    };

    const next = reduce(s, {
      t: "sessions",
      items: [{ id: "selected", title: "Selected", updated: 2 }],
      active: "old",
    });

    expect(next.sessions.items).toHaveLength(1);
    expect(next.sessions.active).toBe("selected");
  });
  it("does not let a sessions frame steal active while readonlyNoHistory is true", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: {
        items: [
          { id: "ro", title: "Read-only", read_only: true },
          { id: "owned", title: "Owned", read_only: false },
        ],
        active: "ro",
      },
      readonlyNoHistory: true,
    };
    const next = reduce(s, {
      t: "sessions",
      items: s.sessions.items,
      active: "owned",
    });
    expect(next.sessions.active).toBe("ro");
  });
  it("sets active from hello.ok and active messages", () => {
    let s = reduce(initialState(), { t: "hello.ok", caps: {}, active: "x" });
    expect(s.sessions.active).toBe("x");
    s = reduce(s, { t: "active", id: "y" });
    expect(s.sessions.active).toBe("y");
    expect(s.history).toEqual({ loadingFor: "y", failedFor: null, refresh: false });
  });
  it("ignores an active frame for a known foreign/read-only session", () => {
    const s: AppState = {
      ...initialState(),
      sessions: {
        items: [
          { id: "tg", title: "Telegram", updated: 1, foreign: true },
          { id: "ro", title: "Read-only", updated: 1, read_only: true },
          { id: "own", title: "Own", updated: 1 },
        ],
        active: "own",
      },
    };
    const next = reduce(s, { t: "active", id: "tg" });
    expect(next.sessions.active).toBe("own");
    expect(next.history).toEqual({ loadingFor: null, failedFor: null, refresh: false });

    const nextRo = reduce(s, { t: "active", id: "ro" });
    expect(nextRo.sessions.active).toBe("own");
  });
  it("still adopts an active frame for an unknown id (freshly created session)", () => {
    const s: AppState = {
      ...initialState(),
      sessions: { items: [{ id: "own", title: "Own", updated: 1 }], active: "own" },
    };
    const next = reduce(s, { t: "active", id: "fresh" });
    expect(next.sessions.active).toBe("fresh");
    expect(next.history.loadingFor).toBe("fresh");
  });
  it("hydrates stream from history when a session is selected", () => {
    const stale: StreamItem[] = [{ kind: "user", text: "stale" }];
    const items: StreamItem[] = [
      { kind: "user", text: "old question" },
      { kind: "assistant", text: "old answer" },
    ];
    const s = {
      ...initialState(),
      stream: stale,
      pending: { transcript: "draft" },
      phase: "review" as const,
      turn: "working" as const,
      scrollPage: 2,
      sessions: { items: [], active: "s1" },
      history: { loadingFor: "s1", failedFor: null },
    };

    const next = reduce(s, { t: "history", id: "s1", items, ok: true });

    expect(next.history).toEqual({ loadingFor: null, failedFor: null, refresh: false });
    expect(next.stream).toEqual(items);
    expect(next.pending).toBeNull();
    expect(next.phase).toBe("idle");
    expect(next.turn).toBe("idle");
    expect(next.scrollPage).toBeNull();
  });
  it("ignores stale history for a session that is no longer active", () => {
    const s: AppState = {
      ...initialState(),
      sessions: { items: [], active: "current" },
      history: { loadingFor: "current", failedFor: null },
      stream: [{ kind: "user", text: "keep me" }],
    };

    const next = reduce(s, { t: "history", id: "old", items: [{ kind: "user", text: "stale" }], ok: true });

    expect(next).toBe(s);
  });
  it("hydrates pending history even after active was overwritten", () => {
    const s: AppState = {
      ...initialState(),
      sessions: { items: [], active: "old" },
      history: { loadingFor: "selected", failedFor: null },
    };

    const next = reduce(s, {
      t: "history",
      id: "selected",
      items: [{ kind: "user", text: "loaded" }],
      ok: true,
    });

    expect(next.sessions.active).toBe("selected");
    expect(next.stream).toEqual([{ kind: "user", text: "loaded" }]);
    expect(next.history).toEqual({ loadingFor: null, failedFor: null, refresh: false });
  });
  it("marks history unavailable when loading failed", () => {
    const s: AppState = {
      ...initialState(),
      sessions: { items: [], active: "s1" },
      history: { loadingFor: "s1", failedFor: null, refresh: false },
    };

    const next = reduce(s, { t: "history", id: "s1", items: [], ok: false });

    expect(next.history).toEqual({ loadingFor: null, failedFor: "s1", refresh: false });
    expect(barText(next)).toBe("history unavailable");
  });
});

describe("reduce: hello.ok never steals the local conversation (F2/F3)", () => {
  const items = [
    { id: "mine", title: "Mine", updated: 3 },
    { id: "other", title: "Other own", updated: 2 },
    { id: "tg", title: "Telegram", updated: 9, foreign: true },
  ];
  function inSession(active = "mine"): AppState {
    return {
      ...initialState(),
      screen: "session",
      sessions: { items, active },
    };
  }

  it("keeps the local active id when the bridge reports active \"\" after a restart", () => {
    const next = reduce(inSession(), { t: "hello.ok", caps: {}, active: "" });
    expect(next.sessions.active).toBe("mine");
  });
  it("keeps the local active id when the bridge reports a foreign session active", () => {
    const next = reduce(inSession(), { t: "hello.ok", caps: {}, active: "tg" });
    expect(next.sessions.active).toBe("mine");
  });
  it("keeps the local active id when the bridge reports a different own session active", () => {
    const next = reduce(inSession(), { t: "hello.ok", caps: {}, active: "other" });
    expect(next.sessions.active).toBe("mine");
  });
  it("still adopts the bridge active id on a cold boot (no local active yet)", () => {
    const s: AppState = { ...initialState(), sessions: { items, active: null } };
    expect(reduce(s, { t: "hello.ok", caps: {}, active: "other" }).sessions.active).toBe("other");
  });
  it("does not adopt a foreign id on a cold boot", () => {
    const s: AppState = { ...initialState(), sessions: { items, active: null } };
    expect(reduce(s, { t: "hello.ok", caps: {}, active: "tg" }).sessions.active).toBeNull();
  });
});

describe("reduce: sessions frames keep the local conversation (F3)", () => {
  const mixed = [
    { id: "mine", title: "Mine", updated: 3 },
    { id: "tg", title: "Telegram", updated: 9, foreign: true },
  ];

  it("keeps active when the frame's active id is a known foreign session (session screen)", () => {
    const s: AppState = {
      ...initialState(), screen: "session",
      sessions: { items: mixed, active: "mine" },
    };
    const next = reduce(s, { t: "sessions", items: mixed, active: "tg" });
    expect(next.sessions.active).toBe("mine");
  });
  it("keeps active on the session screen even when the frame reports active \"\" (bridge restart race)", () => {
    const s: AppState = {
      ...initialState(), screen: "session",
      sessions: { items: mixed, active: "mine" },
    };
    const next = reduce(s, { t: "sessions", items: mixed, active: "" });
    expect(next.sessions.active).toBe("mine");
  });
  it("keeps active when a foreign id is reported while browsing the list", () => {
    const s: AppState = {
      ...initialState(), screen: "list",
      sessions: { items: mixed, active: "mine" },
    };
    const next = reduce(s, { t: "sessions", items: mixed, active: "tg" });
    expect(next.sessions.active).toBe("mine");
  });
  it("still adopts the frame's active id from the list screen with no local active", () => {
    const s: AppState = { ...initialState(), sessions: { items: mixed, active: null } };
    const next = reduce(s, { t: "sessions", items: mixed, active: "mine" });
    expect(next.sessions.active).toBe("mine");
  });
});

describe("reduce: just-created own session lifecycle (F3)", () => {
  it("claims the bridge-assigned id of a session we just created (unknown active frame while expecting)", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      expectingNewSession: true,
      sessions: { items: [{ id: "old", title: "Old", updated: 1 }], active: null },
    };
    const next = reduce(s, { t: "active", id: "fresh-1" });
    expect(next.sessions.active).toBe("fresh-1");
    expect(next.unconfirmedOwnId).toBe("fresh-1");
    expect(next.expectingNewSession).toBe(false);
    expect(next.history.loadingFor).toBe("fresh-1");
  });
  it("does not claim an unknown active frame when no new session was requested", () => {
    const s: AppState = {
      ...initialState(),
      sessions: { items: [{ id: "old", title: "Old", updated: 1 }], active: "old" },
    };
    const next = reduce(s, { t: "active", id: "mystery" });
    expect(next.sessions.active).toBe("mystery");
    expect(next.unconfirmedOwnId).toBeNull();
  });
  it("confirms the unconfirmed id once a list shows it as own, and drops it if foreign", () => {
    const claimed: AppState = {
      ...initialState(),
      unconfirmedOwnId: "fresh-1",
      sessions: { items: [], active: "fresh-1" },
    };
    const confirmed = reduce(claimed, {
      t: "sessions",
      items: [{ id: "fresh-1", title: "New", updated: 5 }],
      active: "fresh-1",
    });
    expect(confirmed.unconfirmedOwnId).toBeNull();

    const foreign = reduce(claimed, {
      t: "sessions",
      items: [{ id: "fresh-1", title: "TG", updated: 5, foreign: true }],
      active: "fresh-1",
    });
    expect(foreign.unconfirmedOwnId).toBeNull();
  });
  it("keeps the unconfirmed id while the list does not mention it yet", () => {
    const claimed: AppState = {
      ...initialState(),
      unconfirmedOwnId: "fresh-1",
      sessions: { items: [], active: "fresh-1" },
    };
    const next = reduce(claimed, { t: "sessions", items: [], active: "" });
    expect(next.unconfirmedOwnId).toBe("fresh-1");
  });
});

describe("reduce: history refresh after a reconnect re-pin preserves in-progress work (F1)", () => {
  function midConversation(): AppState {
    return {
      ...initialState(),
      screen: "session",
      conn: "reconnecting",
      phase: "review",
      pending: { transcript: "draft me" },
      scrollPage: 1,
      sessions: { items: [{ id: "a", title: "A", updated: 9 }], active: "a" },
      history: { loadingFor: "a", failedFor: null, refresh: true },
      stream: [
        { kind: "user", text: "hi", id: "t1", delivery: "delivered" },
        { kind: "user", text: "unsent", id: "t2", delivery: "uncertain" },
      ],
    };
  }
  it("keeps the pending review transcript, review phase and scroll position", () => {
    const next = reduce(midConversation(), {
      t: "history",
      id: "a",
      items: [{ kind: "user", text: "hi" }, { kind: "assistant", text: "hello" }],
      ok: true,
    });
    expect(next.pending).toEqual({ transcript: "draft me" });
    expect(next.phase).toBe("review");
    expect(next.scrollPage).toBe(1);
    expect(next.turn).toBe("idle");
  });
  it("re-attaches local uncertain turns the server never received", () => {
    const next = reduce(midConversation(), {
      t: "history",
      id: "a",
      items: [{ kind: "user", text: "hi" }, { kind: "assistant", text: "hello" }],
      ok: true,
    });
    const texts = next.stream.filter((i) => i.kind === "user");
    expect(texts.map((i) => (i as { text: string }).text)).toEqual(["hi", "unsent"]);
  });
  it("drops a local uncertain turn the server DID receive (by text)", () => {
    const next = reduce(midConversation(), {
      t: "history",
      id: "a",
      items: [
        { kind: "user", text: "hi" },
        { kind: "user", text: "unsent" },
        { kind: "assistant", text: "answered" },
      ],
      ok: true,
    });
    const userTexts = next.stream.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
    expect(userTexts).toEqual(["hi", "unsent"]);
    expect(next.stream).toHaveLength(3);
  });
  it("a cold history load (empty local stream) still resets phase and pending", () => {
    const s: AppState = {
      ...midConversation(),
      stream: [],
      history: { loadingFor: "a", failedFor: null, refresh: true },
    };
    const next = reduce(s, { t: "history", id: "a", items: [{ kind: "user", text: "hi" }], ok: true });
    expect(next.pending).toBeNull();
    expect(next.phase).toBe("idle");
  });
});

describe("reduce: refused re-pin keeps the conversation it failed to refresh (N1c)", () => {
  // The bridge answers a refused re-pin switch with an error frame followed by
  // history(id, [], ok:false) and NO active frame — so the refresh flag never
  // armed and the reducer's refresh path does not apply.
  function rePinned(): AppState {
    return {
      ...initialState(),
      screen: "session",
      conn: "connected",
      phase: "review",
      pending: { transcript: "draft me" },
      scrollPage: 1,
      sessions: { items: [{ id: "a", title: "A", updated: 9 }], active: "a" },
      history: { loadingFor: null, failedFor: null, refresh: false },
      stream: [
        { kind: "user", text: "hi", id: "t1", delivery: "delivered" },
        { kind: "user", text: "unsent", id: "t2", delivery: "uncertain" },
      ],
    };
  }
  it("history ok:false with a non-empty local stream keeps stream, pending and phase", () => {
    const next = reduce(rePinned(), { t: "history", id: "a", items: [], ok: false });
    expect(next.stream).toHaveLength(2);
    expect(next.pending).toEqual({ transcript: "draft me" });
    expect(next.phase).toBe("review");
    expect(next.scrollPage).toBe(1);
    expect(next.sessions.active).toBe("a");
    expect(next.history).toEqual({ loadingFor: null, failedFor: "a", refresh: false });
  });
  it("a refused cold load (empty local stream) still resets phase and pending", () => {
    const s: AppState = { ...rePinned(), stream: [], pending: null, phase: "idle" };
    const next = reduce(s, { t: "history", id: "a", items: [], ok: false });
    expect(next.stream).toEqual([]);
    expect(next.pending).toBeNull();
    expect(next.phase).toBe("idle");
    expect(next.history).toEqual({ loadingFor: null, failedFor: "a", refresh: false });
  });
});

describe("reduce: stream", () => {
  it("assistant output BEFORE the first user item is a banner", () => {
    let s = initialState();
    s = reduce(s, { t: "assistant.delta", text: "model: x" });
    s = reduce(s, { t: "assistant.delta", text: "\ncwd: y" });
    expect(s.stream).toEqual([{ kind: "banner", text: "model: x\ncwd: y" }]);
  });
  it("assistant output AFTER a user item is assistant text", () => {
    let s: AppState = { ...initialState(), stream: [{ kind: "user", text: "hi" }], scrollPage: 2 };
    s = reduce(s, { t: "assistant.delta", text: "It's" });
    s = reduce(s, { t: "assistant.delta", text: " Friday" });
    expect(s.stream).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "It's Friday" },
    ]);
    expect(s.scrollPage).toBeNull();
  });
  it("a full assistant frame after a user item appends assistant text", () => {
    let s: AppState = { ...initialState(), stream: [{ kind: "user", text: "hi" }] };
    s = reduce(s, { t: "assistant", text: "hello there" });
    expect(s.stream).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello there" },
    ]);
  });
  it("full assistant frames replace the current assistant snapshot", () => {
    let s: AppState = { ...initialState(), stream: [{ kind: "user", text: "hi" }] };
    s = reduce(s, { t: "assistant", text: "hello" });
    s = reduce(s, { t: "assistant", text: "hello there" });
    expect(s.stream).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello there" },
    ]);
  });
  it("a delta after a tool opens a NEW assistant segment", () => {
    let s: AppState = { ...initialState(), stream: [{ kind: "user", text: "hi" }] };
    s = reduce(s, { t: "assistant.delta", text: "Checking…" });
    s = reduce(s, { t: "tool.start", name: "terminal" });
    s = reduce(s, { t: "tool.end", name: "terminal", ok: true });
    s = reduce(s, { t: "assistant.delta", text: "Done." });
    expect(s.stream).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "Checking…" },
      { kind: "tool", name: "terminal", running: false, ok: true },
      { kind: "assistant", text: "Done." },
    ]);
  });
  it("pushes a running tool on tool.start and sets turn=working", () => {
    let s = reduce({ ...initialState(), scrollPage: 2 }, { t: "tool.start", name: "terminal" });
    expect(s.turn).toBe("working");
    expect(s.scrollPage).toBeNull();
    expect(s.stream).toEqual([{ kind: "tool", name: "terminal", running: true }]);
  });
  it("patches the matching running tool to done on tool.end", () => {
    let s = initialState();
    s = reduce(s, { t: "tool.start", name: "terminal", label: "Run terminal" });
    s = reduce(s, { t: "tool.end", name: "terminal", ok: true });
    expect(s.stream).toEqual([{ kind: "tool", name: "terminal", label: "Run terminal", running: false, ok: true }]);
  });
  it("sets turn=idle on turn.done", () => {
    let s = reduce(initialState(), { t: "tool.start", name: "x" });
    s = reduce(s, { t: "turn.done" });
    expect(s.turn).toBe("idle");
  });
  it("consecutive assistant deltas coalesce into one item", () => {
    let s = { ...initialState(), stream: [{ kind: "user", text: "hi" } as StreamItem] };
    s = reduce(s, { t: "assistant.delta", text: "First." });
    s = reduce(s, { t: "assistant.delta", text: "Second." });
    const assistant = s.stream.filter((i) => i.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].kind === "assistant" && assistant[0].text).toBe("First.Second.");
  });
});

describe("reduce: transcript guard", () => {
  it("sets pending + review only when phase is transcribing", () => {
    const s = { ...initialState(), screen: "session" as const, phase: "transcribing" as const, scrollPage: 2 };
    const next = reduce(s, { t: "transcript", text: "add dark mode" });
    expect(next.pending).toEqual({ transcript: "add dark mode" });
    expect(next.phase).toBe("review");
    expect(next.scrollPage).toBeNull();
  });
  it("ignores a transcript that arrives in any other phase (cancel path)", () => {
    const s = { ...initialState(), screen: "session" as const, phase: "idle" as const };
    const next = reduce(s, { t: "transcript", text: "stale" });
    expect(next.pending).toBeNull();
    expect(next.phase).toBe("idle");
  });
  it("drops an empty/whitespace transcript back to idle with a retry notice", () => {
    const s = { ...initialState(), screen: "session" as const, phase: "transcribing" as const };
    const next = reduce(s, { t: "transcript", text: "   " });
    expect(next.phase).toBe("idle");
    expect(next.pending).toBeNull();
    expect(next.notice).toBe("didn't catch that · tap to retry");
  });
  it("a non-empty transcript still goes to review", () => {
    const s = { ...initialState(), screen: "session" as const, phase: "transcribing" as const };
    const next = reduce(s, { t: "transcript", text: "hello" });
    expect(next.phase).toBe("review");
    expect(next.pending).toEqual({ transcript: "hello" });
  });
});

describe("barText", () => {
  const base = { ...initialState(), screen: "session" as const };
  it("recording / transcribing / review", () => {
    expect(barText({ ...base, phase: "recording" })).toBe("● recording · tap to stop");
    expect(barText({ ...base, phase: "transcribing" })).toBe("transcribing…");
    expect(barText({ ...base, phase: "review" })).toBe("tap = send · swipe↓ = discard");
  });
  it("idle reflects the turn state", () => {
    expect(barText({ ...base, phase: "idle", turn: "idle" })).toBe("ready");
    expect(barText({ ...base, phase: "idle", turn: "thinking" })).toBe("thinking…");
  });
  it("shows history loading before idle status", () => {
    expect(barText({
      ...base,
      phase: "idle",
      sessions: { items: [], active: "s1" },
      history: { loadingFor: "s1", failedFor: null },
    })).toBe("loading session...");
  });
  it("working names the active tool", () => {
    const s = { ...base, phase: "idle" as const, turn: "working" as const,
      stream: [{ kind: "tool" as const, name: "terminal", running: true }] };
    expect(barText(s)).toBe("working… (terminal)");
  });
  it("surfaces notice frame in barText when idle", () => {
    const s = reduce(base, { t: "notice", text: "Some replies were lost while the glasses were offline." } as any);
    expect(barText(s)).toBe("Some replies were lost while the glasses were offline.");
  });
  it("surfaces honest banner for readonly session without history", () => {
    const s = { ...base, phase: "idle" as const, readonlyNoHistory: true };
    expect(barText(s)).toBe("History not shown (Telegram-owned session, read-only)");
  });

  it("shows the resend hint whenever the last user turn is uncertain, even after the notice expired (F6)", () => {
    const uncertain = {
      ...base,
      phase: "idle" as const,
      conn: "connected",
      notice: null,
      stream: [{ kind: "user" as const, text: "did it land?", id: "t1", delivery: "uncertain" as const }],
    };
    expect(barText(uncertain)).toBe("not delivered · tap to resend");
  });
  it("shows an offline resend hint when the socket is down (F6)", () => {
    const uncertain = {
      ...base,
      phase: "idle" as const,
      conn: "reconnecting",
      notice: null,
      stream: [{ kind: "user" as const, text: "did it land?", id: "t1", delivery: "uncertain" as const }],
    };
    expect(barText(uncertain)).toBe("not delivered · resend when online");
  });
  it("a fresh notice still wins over the resend hint", () => {
    const s = {
      ...base,
      phase: "idle" as const,
      conn: "connected",
      notice: "error: boom",
      stream: [{ kind: "user" as const, text: "x", id: "t1", delivery: "uncertain" as const }],
    };
    expect(barText(s)).toBe("error: boom");
  });
  it("an uncertain turn buried under a reply no longer claims the bar", () => {
    const s = {
      ...base,
      phase: "idle" as const,
      conn: "connected",
      stream: [
        { kind: "user" as const, text: "x", id: "t1", delivery: "uncertain" as const },
        { kind: "assistant" as const, text: "answer" },
      ],
    };
    expect(barText(s)).toBe("ready");
  });
});

describe("offlineNotice text follows the connection state (F9b)", () => {
  it("auto-reconnecting states say reconnecting", () => {
    expect(offlineNotice("reconnecting")).toBe("offline · reconnecting…");
    expect(offlineNotice("websocket error; reconnecting")).toBe("offline · reconnecting…");
    expect(offlineNotice("connecting wss://bridge")).toBe("offline · reconnecting…");
  });
  it("dead connections ask for a check instead of promising reconnects", () => {
    expect(offlineNotice("error: bridge token rejected")).toBe("offline · check connection");
    expect(offlineNotice("disconnected")).toBe("offline · check connection");
    expect(offlineNotice("not configured")).toBe("offline · check connection");
  });
});

describe("connDot", () => {
  it("filled when connected, hollow otherwise", () => {
    expect(connDot("connected")).toBe("●");
    expect(connDot("reconnecting")).toBe("◌");
  });
});

describe("reduce: error frames", () => {
  it("routes an error frame to notice and leaves conn alone (dot stays honest)", () => {
    const s: AppState = { ...initialState(), conn: "connected" };
    const next = reduce(s, { t: "error", msg: "bridge hiccup" });
    expect(next.conn).toBe("connected");
    expect(next.notice).toBe("error: bridge hiccup");
  });
  it("stops a running turn so the bar never says thinking forever (F9c)", () => {
    const s: AppState = { ...initialState(), conn: "connected", turn: "thinking" };
    const next = reduce(s, { t: "error", msg: "turn rejected" });
    expect(next.turn).toBe("idle");
  });
  it("truncates a long error message to the status-bar width (F9c)", () => {
    const s: AppState = { ...initialState(), conn: "connected" };
    const next = reduce(s, { t: "error", msg: "x".repeat(300) });
    expect(next.notice!.length).toBeLessThanOrEqual(64);
    expect(next.notice!.endsWith("…")).toBe(true);
  });
  it("stops waiting for history when the awaited session errors out (F7)", () => {
    const s: AppState = {
      ...initialState(), conn: "connected",
      screen: "session",
      sessions: { items: [], active: "s1" },
      history: { loadingFor: "s1", failedFor: null, refresh: false },
    };
    const next = reduce(s, { t: "error", msg: "no such session" });
    expect(next.history.loadingFor).toBeNull();
    expect(next.history.failedFor).toBe("s1");
  });
  it("an error during a refresh load keeps the refresh flag so a late ok history still merges (JC4)", () => {
    const s: AppState = {
      ...initialState(), conn: "connected",
      screen: "session",
      sessions: { items: [], active: "s1" },
      history: { loadingFor: "s1", failedFor: null, refresh: true },
      stream: [{ kind: "user", text: "kept draft", id: "t1", delivery: "pending" }],
    };
    const next = reduce(s, { t: "error", msg: "turn rejected" });
    expect(next.history.loadingFor).toBeNull();
    expect(next.history.refresh).toBe(true);
  });
});

describe("applyDisconnected", () => {
  it("marks pending turns uncertain and resets recording/transcribing to idle", () => {
    const recording: AppState = {
      ...initialState(),
      screen: "session",
      conn: "reconnecting",
      phase: "recording",
      stream: [{ kind: "user", text: "in flight", id: "t1", delivery: "pending" }],
    };
    const next = applyDisconnected(recording);
    expect(next.phase).toBe("idle");
    expect(next.stream[0]).toMatchObject({ delivery: "uncertain" });

    const transcribing = applyDisconnected({ ...recording, phase: "transcribing" });
    expect(transcribing.phase).toBe("idle");
  });
});

describe("ack and delivery status", () => {
  it("ack with ok=true sets delivery to delivered", () => {
    const s: AppState = {
      ...initialState(),
      turn: "thinking",
      stream: [{ kind: "user", text: "do something", id: "turn-1", delivery: "pending" }],
    };
    const next = reduce(s, { t: "ack", id: "turn-1", ok: true } as any);
    expect(next.stream[0]).toEqual({
      kind: "user",
      text: "do something",
      id: "turn-1",
      delivery: "delivered",
    });
    expect(next.turn).toBe("thinking");
  });

  it("ack with ok=false sets delivery to uncertain, turn to idle, and surfaces status text", () => {
    const s: AppState = {
      ...initialState(),
      conn: "connected",
      turn: "thinking",
      stream: [{ kind: "user", text: "do something", id: "turn-1", delivery: "pending" }],
    };
    const next = reduce(s, { t: "ack", id: "turn-1", ok: false, error: "failed" } as any);
    expect(next.stream[0]).toEqual({
      kind: "user",
      text: "do something",
      id: "turn-1",
      delivery: "uncertain",
    });
    expect(next.turn).toBe("idle");
    expect(next.notice).toBe("not delivered · tap to resend");
    expect(barText(next)).toBe("not delivered · tap to resend");
  });

  it("markDeliveryUncertain flips pending user turns to uncertain and sets notice", async () => {
    const { markDeliveryUncertain } = await import("../src/state/store");
    const s: AppState = {
      ...initialState(),
      conn: "connected",
      turn: "thinking",
      stream: [
        { kind: "user", text: "first", id: "t1", delivery: "delivered" },
        { kind: "user", text: "second", id: "t2", delivery: "pending" },
      ],
    };
    const next = markDeliveryUncertain(s, "t2");
    expect(next.stream[1]).toEqual({
      kind: "user",
      text: "second",
      id: "t2",
      delivery: "uncertain",
    });
    expect(next.turn).toBe("idle");
    expect(next.notice).toBe("not delivered · tap to resend");

    // Without id, marks any pending delivery
    const sAll: AppState = {
      ...initialState(),
      conn: "connected",
      turn: "thinking",
      stream: [{ kind: "user", text: "second", id: "t3", delivery: "pending" }],
    };
    const nextAll = markDeliveryUncertain(sAll);
    expect(nextAll.stream[0].delivery).toBe("uncertain");
    expect(nextAll.turn).toBe("idle");
    expect(nextAll.notice).toBe("not delivered · tap to resend");
  });
});

describe("glyphs the firmware can actually render", () => {
  // Unknown glyphs are dropped SILENTLY — no error, no placeholder, just a gap.
  // The mic emoji in the recording bar rendered as nothing at all.
  it("no bar string contains an emoji", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const base = initialState();
    for (const phase of ["idle", "recording", "transcribing", "review"] as const) {
      expect(barText({ ...base, phase })).not.toMatch(emoji);
    }
  });
});
