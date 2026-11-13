import { describe, it, expect } from "vitest";
import { applyServerMessage, type ConnectionFlags } from "../src/state/connection";
import { initialState, applyDisconnected, reduce, type AppState } from "../src/state/store";
import { parseServer, sessionsList, sessionsNew, sessionsSwitch } from "../src/protocol";

const freshFlags = (): ConnectionFlags => ({ helloOk: false, bootResumeDone: false });

const own = (id: string, updated = 1) => ({ id, title: `chat ${id}`, updated });

function connected(state: AppState, flags: ConnectionFlags) {
  return { state, flags };
}

describe("applyServerMessage: boot resume runs exactly once per app launch (F1/F12)", () => {
  it("three sessions frames on one connection fire the resume exactly once", () => {
    const items = [own("a", 3), own("b", 1)];
    let { state, flags } = connected(initialState(), freshFlags());
    let resumes = 0;
    let resumeSwitches = 0;

    for (let i = 0; i < 3; i++) {
      const r = applyServerMessage(state, { t: "sessions", items, active: "a" }, flags, null);
      if (r.resumed) {
        resumes++;
        resumeSwitches += r.effects.filter((e) => e.kind === "send").length;
      }
      state = r.state;
      flags = r.flags;
    }

    expect(resumes).toBe(1);
    expect(resumeSwitches).toBe(1);
    expect(flags.bootResumeDone).toBe(true);
    expect(state.screen).toBe("session");
    expect(state.sessions.active).toBe("a");
  });

  it("a reconnect (hello.ok + sessions after a disconnect) re-pins instead of resuming, and keeps in-progress work", () => {
    let { state, flags } = connected(initialState(), freshFlags());

    // Boot: hello, first list → resume lands in "a" and loads history.
    let r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "a" }, flags, null);
    state = r.state; flags = r.flags;
    r = applyServerMessage(state, { t: "sessions", items: [own("a", 9)], active: "a" }, flags, null);
    expect(r.resumed).toBe(true);
    state = r.state; flags = r.flags;
    r = applyServerMessage(state, { t: "active", id: "a" }, flags, null);
    state = r.state; flags = r.flags;
    state = applyServerMessage(state, { t: "history", id: "a", items: [{ kind: "user", text: "hi" }], ok: true }, flags, null).state;

    // The wearer records a draft and has an unsent turn when the socket drops.
    state = {
      ...state,
      phase: "review",
      pending: { transcript: "draft me" },
      stream: [
        { kind: "user", text: "hi" },
        { kind: "user", text: "unsent", id: "t2", delivery: "uncertain" },
      ],
    };
    state = applyDisconnected(state);

    // Reconnect: bridge restarted, hello.ok says active "".
    r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "" }, flags, null);
    state = r.state; flags = r.flags;
    expect(r.effects).toEqual([
      { kind: "send", frame: sessionsSwitch("a") },
      { kind: "send", frame: sessionsList() },
    ]);

    // The sessions frame after reconnect must NOT resume (no state wipe)…
    r = applyServerMessage(state, { t: "sessions", items: [own("a", 9)], active: "" }, flags, null);
    expect(r.resumed).toBe(false);
    expect(r.flags.bootResumeDone).toBe(true);
    state = r.state;

    // …and the in-progress work is intact.
    expect(state.screen).toBe("session");
    expect(state.sessions.active).toBe("a");
    expect(state.pending).toEqual({ transcript: "draft me" });
    expect(state.phase).toBe("review");
    expect(state.stream.some((i) => i.kind === "user" && i.delivery === "uncertain")).toBe(true);
  });
});

describe("applyServerMessage: hello.ok re-pin reads the id from BEFORE the reduce (F2)", () => {
  function midConversation(): { state: AppState; flags: ConnectionFlags } {
    return connected(
      {
        ...initialState(),
        screen: "session",
        sessions: {
          items: [own("mine", 3), own("other", 2), { id: "tg", title: "Telegram", updated: 9, foreign: true }],
          active: "mine",
        },
        stream: [{ kind: "user", text: "hi" }],
      },
      freshFlags(),
    );
  }
  const rePin = (frame: string) => [
    { kind: "send", frame: sessionsSwitch("mine") },
    { kind: "send", frame: sessionsList() },
  ];

  it("re-pins the local own id when the bridge reports active \"\" (restart)", () => {
    const { state, flags } = midConversation();
    const r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "" }, flags, null);
    expect(r.state.sessions.active).toBe("mine");
    expect(r.effects).toEqual(rePin(sessionsSwitch("mine")));
  });
  it("re-pins the local own id when the bridge reports a foreign session active", () => {
    const { state, flags } = midConversation();
    const r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "tg" }, flags, null);
    expect(r.state.sessions.active).toBe("mine");
    expect(r.effects).toEqual(rePin(sessionsSwitch("mine")));
  });
  it("re-pins the local own id when the bridge reports a different own session active", () => {
    const { state, flags } = midConversation();
    const r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "other" }, flags, null);
    expect(r.state.sessions.active).toBe("mine");
    expect(r.effects).toEqual(rePin(sessionsSwitch("mine")));
  });
  it("does not send a redundant switch when the bridge already has our session active", () => {
    const { state, flags } = midConversation();
    const r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "mine" }, flags, null);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsList() }]);
  });
  it("no re-pin on a cold boot with no local active id", () => {
    const r = applyServerMessage(initialState(), { t: "hello.ok", caps: {}, active: "a" }, freshFlags(), null);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsList() }]);
  });
  it("re-pins our just-created session even though no list confirms it yet", () => {
    const state: AppState = {
      ...initialState(),
      screen: "session",
      unconfirmedOwnId: "fresh-1",
      sessions: { items: [own("old", 1)], active: "fresh-1" },
    };
    const r = applyServerMessage(state, { t: "hello.ok", caps: {}, active: "" }, freshFlags(), null);
    expect(r.effects).toContainEqual({ kind: "send", frame: sessionsSwitch("fresh-1") });
  });
});

describe("applyServerMessage: cross-surface handoff switch (V2)", () => {
  const flags = (): ConnectionFlags => ({ helloOk: true, bootResumeDone: true });
  const items = [
    { id: "tg-1", title: "Telegram", updated: 9, foreign: true, platform: "telegram" },
    own("own-1", 3),
  ];

  it("adopts the minted handoff child, loads its history, persists once listed own", () => {
    // The wearer tapped the resumable foreign row; enterSession armed loadingFor.
    let s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: { items, active: "tg-1" },
      history: { loadingFor: "tg-1", failedFor: null, refresh: false },
    };

    // Bridge: cross-surface handoff minted even_g2 child g2-2.
    const r1 = applyServerMessage(s, { t: "active", id: "g2-2", handoff_from: "tg-1", conversation_id: "tg-1" }, flags(), null);
    expect(r1.state.sessions.active).toBe("g2-2");
    expect(r1.state.history.loadingFor).toBe("g2-2");
    expect(r1.persist).toBeNull(); // not yet listed own

    // The following sessions frame lists g2-2 own: NOW its id is safe to save.
    const r2 = applyServerMessage(r1.state, {
      t: "sessions",
      items: [...items, { id: "g2-2", title: "Telegram", updated: 10, handoff_from: "tg-1", conversation_id: "tg-1" }],
      active: "g2-2",
    }, flags(), null);
    expect(r2.state.unconfirmedOwnId).toBeNull();
    expect(r2.persist).toBe("g2-2");

    // And the history of the handoff child loads its turns.
    const r3 = applyServerMessage(r2.state, { t: "history", id: "g2-2", items: [{ kind: "user", text: "hi" }], ok: true }, flags(), null);
    expect(r3.state.stream).toEqual([{ kind: "user", text: "hi" }]);
    expect(r3.state.history.loadingFor).toBeNull();
  });
});

describe("applyServerMessage: persistence is gated on confirmed own ids (F3c)", () => {
  const items = [own("mine", 3), { id: "tg", title: "Telegram", updated: 9, foreign: true }];

  it("persists an active frame for a known own session", () => {
    const s: AppState = { ...initialState(), sessions: { items, active: null } };
    const r = applyServerMessage(s, { t: "active", id: "mine" }, freshFlags(), null);
    expect(r.persist).toBe("mine");
  });
  it("never persists a foreign, unknown, or empty id", () => {
    const base: AppState = { ...initialState(), sessions: { items, active: "mine" } };
    expect(applyServerMessage(base, { t: "active", id: "tg" }, freshFlags(), null).persist).toBeNull();
    expect(applyServerMessage(base, { t: "active", id: "mystery" }, freshFlags(), null).persist).toBeNull();
    expect(
      applyServerMessage(base, { t: "hello.ok", caps: {}, active: "" }, freshFlags(), null).persist,
    ).toBeNull();
  });
  it("persists the just-created session id once a list confirms it own", () => {
    const claimed: AppState = {
      ...initialState(),
      unconfirmedOwnId: "fresh-1",
      sessions: { items: [], active: "fresh-1" },
    };
    const r = applyServerMessage(
      claimed,
      { t: "sessions", items: [...items, own("fresh-1", 9)], active: "fresh-1" },
      freshFlags(),
      null,
    );
    expect(r.state.unconfirmedOwnId).toBeNull();
    expect(r.persist).toBe("fresh-1");
  });
  it("does not persist the just-created id when the list reveals it foreign", () => {
    const claimed: AppState = {
      ...initialState(),
      unconfirmedOwnId: "fresh-1",
      sessions: { items: [], active: "fresh-1" },
    };
    const r = applyServerMessage(
      claimed,
      { t: "sessions", items: [{ id: "fresh-1", title: "TG", updated: 9, foreign: true }], active: "fresh-1" },
      freshFlags(),
      null,
    );
    expect(r.persist).toBeNull();
  });
});

describe("applyServerMessage: refused resume recovers (F7)", () => {
  it("an error while history loads falls back to the next own session with a notice", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: { items: [own("dead", 9), own("alive", 5)], active: "dead" },
      history: { loadingFor: "dead", failedFor: null, refresh: false },
    };
    const r = applyServerMessage(s, { t: "error", msg: "session not found" }, freshFlags(), null);
    expect(r.state.sessions.active).toBe("alive");
    expect(r.state.history.loadingFor).toBe("alive");
    expect(r.state.history.failedFor).toBe("dead");
    expect(r.state.notice).toBe("couldn't open that session");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("alive") }]);
  });
  it("a fallback that fails too creates a fresh session instead of hopping again", () => {
    // First failure already recorded ("dead"); now the fallback "alive" errors.
    const s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: { items: [own("dead", 9), own("alive", 5)], active: "alive" },
      history: { loadingFor: "alive", failedFor: "dead", refresh: false },
    };
    const r = applyServerMessage(s, { t: "error", msg: "also gone" }, freshFlags(), null);
    expect(r.state.sessions.active).toBeNull();
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("an error during a re-pin refresh window keeps the in-progress work (N1b)", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      conn: "connected",
      phase: "review",
      pending: { transcript: "draft me" },
      sessions: { items: [own("a", 9), own("b", 1)], active: "a" },
      history: { loadingFor: "a", failedFor: null, refresh: true },
      stream: [{ kind: "user", text: "hi", id: "t1", delivery: "delivered" }],
    };
    const r = applyServerMessage(s, { t: "error", msg: "switch refused" }, freshFlags(), null);
    expect(r.state.sessions.active).toBe("a"); // no fallback jump
    expect(r.state.pending).toEqual({ transcript: "draft me" });
    expect(r.state.stream).toHaveLength(1);
    expect(r.state.phase).toBe("review");
    expect(r.state.history.loadingFor).toBeNull();
    expect(r.effects).toEqual([]);
    expect(r.state.notice).toContain("switch refused");
  });
  it("an error during a fallback load (refresh flag set, EMPTY stream) still recovers", () => {
    // The fallback's confirming active frame sets refresh=true over a stream
    // enterSession just wiped — there is no work to keep, so F7 must run.
    const s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: { items: [own("dead", 9), own("alive", 5)], active: "alive" },
      history: { loadingFor: "alive", failedFor: "dead", refresh: true },
      stream: [],
    };
    const r = applyServerMessage(s, { t: "error", msg: "also gone" }, freshFlags(), null);
    expect(r.state.sessions.active).toBeNull();
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("an error outside a history load is notice-only (no session jump)", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      sessions: { items: [own("a", 9)], active: "a" },
    };
    const r = applyServerMessage(s, { t: "error", msg: "turn rejected" }, freshFlags(), null);
    expect(r.state.sessions.active).toBe("a");
    expect(r.effects).toEqual([]);
    expect(r.state.notice).toContain("turn rejected");
  });
});

describe("applyServerMessage / applyDisconnected: prompts clear on reconnect and drop (§C rule 8)", () => {
  function withPrompt(): AppState {
    // A prompt.request lands mid-conversation.
    return reduce(
      {
        ...initialState(),
        screen: "session",
        sessions: { items: [own("mine", 3)], active: "mine" },
        stream: [{ kind: "user", text: "hi" }],
      },
      {
        t: "prompt.request",
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
      },
    );
  }

  it("a new hello.ok clears the queued prompt (mid-conversation, re-pin path)", () => {
    const s = withPrompt();
    expect(s.prompts.map((p) => p.id)).toEqual(["p1"]); // fixture sanity
    const r = applyServerMessage(s, { t: "hello.ok", caps: {}, active: "" }, freshFlags(), null);
    expect(r.state.prompts).toEqual([]);
    expect(r.state.promptHighlight).toBe(0);
    // The re-pin still fires: the conversation survives, the prompt doesn't.
    expect(r.effects).toContainEqual({ kind: "send", frame: sessionsList() });
  });

  it("a disconnect clears the queued prompt", () => {
    const s = withPrompt();
    const next = applyDisconnected(s);
    expect(next.prompts).toEqual([]);
    expect(next.promptHighlight).toBe(0);
  });
});

describe("V3 mirror frames (TG2G): Telegram turns mirrored onto the G2 leg", () => {
  const mirror = (id: string, user: string, assistant: string) => ({
    t: "mirror" as const,
    id,
    from: "telegram",
    turn_id: "turn-1",
    user,
    assistant,
  });

  const inSession = (): AppState => ({
    ...initialState(),
    screen: "session",
    sessions: { items: [own("g2-1")], active: "g2-1" },
    stream: [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi" },
    ],
  });

  it("applies a mirror turn to the active session: [TG] user line then reply, one reduce call", () => {
    const s1 = reduce(inSession(), mirror("g2-1", "status?", "All good."));
    expect(s1.stream).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi" },
      { kind: "user", text: "[TG] status?" },
      { kind: "assistant", text: "All good." },
    ]);
  });

  it("drops a mirror frame for a non-active session", () => {
    const s0 = inSession();
    expect(reduce(s0, mirror("other-leg", "q", "a"))).toBe(s0);
  });

  it("drops a mirror frame when no session is active", () => {
    const s0 = initialState();
    expect(reduce(s0, mirror("g2-1", "q", "a"))).toBe(s0);
  });

  it("CYCLES #2: a parsed mirror frame never causes an outgoing client message", () => {
    // Full pipeline: parse (as ws-client does) → applyServerMessage → effects.
    for (const id of ["g2-1", "other-leg"]) {
      const raw = JSON.stringify(mirror(id, "q", "a"));
      const r = applyServerMessage(
        inSession(),
        parseServer(raw),
        { helloOk: true, bootResumeDone: true },
        null,
      );
      expect(r.effects, `mirror id=${id}`).toEqual([]);
      expect(r.persist, `mirror id=${id}`).toBeNull();
    }
  });
});
