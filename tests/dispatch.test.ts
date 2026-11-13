import { describe, it, expect } from "vitest";
import { dispatch, resumeOnBoot, recoverUnavailableSession } from "../src/input/dispatch";
import { initialState, reduce, type AppState, type Prompt } from "../src/state/store";
import { sessionsNew, sessionsSwitch, textMsg, sessionsList, promptResponse } from "../src/protocol";
import { threadPages } from "../src/ui/stream";
import { buildListView } from "../src/ui/views";

function listWith(items: { id: string; title: string; updated?: number; read_only?: boolean; foreign?: boolean; platform?: string }[]): AppState {
  return {
    ...initialState(),
    sessionsLoaded: true,
    sessions: { items: items.map((i) => ({ ...i, updated: i.updated ?? 0 })), active: null },
  };
}

describe("dispatch: list", () => {
  it("ignores taps until sessions hydrate", () => {
    const r = dispatch(initialState(), "click", 0);
    expect(r.state.screen).toBe("list");
    expect(r.effects).toEqual([]);
  });
  it("double-press exits the app even while sessions are still loading", () => {
    const r = dispatch(initialState(), "doubleClick");
    expect(r.effects).toEqual([{ kind: "exit" }]);
    expect(r.state.screen).toBe("list");
  });

  it("a single tap on ＋New (or with no row info) starts a new session (user directive)", () => {
    const s = listWith([
      { id: "a", title: "A", updated: 1 },
      { id: "b", title: "B", updated: 2 },
    ]);
    for (const index of [undefined, 0]) {
      const r = dispatch(s, "click", index);
      expect(r.state.screen).toBe("session");
      expect(r.state.expectingNewSession).toBe(true);
      expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    }
  });
  it("a single tap with no own session starts the first one (no hint detour)", () => {
    const s = listWith([
      { id: "tg", title: "Telegram", foreign: true },
      { id: "ro", title: "Readonly", read_only: true },
    ]);
    const r = dispatch(s, "click", 0);
    expect(r.state.screen).toBe("session");
    expect(r.state.expectingNewSession).toBe(true);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("index 1 opens the first existing session", () => {
    const r = dispatch(listWith([{ id: "a", title: "A" }, { id: "b", title: "B" }]), "click", 1);
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBe("a");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("a") }]);
  });
  it("index 1 opens the newest session when the server sends oldest-first", () => {
    const r = dispatch(listWith([
      { id: "old", title: "Old", updated: 1 },
      { id: "new", title: "New", updated: 3 },
      { id: "middle", title: "Middle", updated: 2 },
    ]), "click", 1);
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBe("new");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("new") }]);
  });
  it("list indexes follow newest-first order after the new row", () => {
    const r = dispatch(listWith([
      { id: "old", title: "Old", updated: 1 },
      { id: "new", title: "New", updated: 3 },
      { id: "middle", title: "Middle", updated: 2 },
    ]), "click", 2);
    expect(r.state.sessions.active).toBe("middle");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("middle") }]);
  });
  it("read-only sessions never appear in the list snapshot; resumable foreign rows do", () => {
    const s = listWith([
      { id: "ro", title: "Locked session", read_only: true },
      { id: "tg", title: "Foreign session", foreign: true },
      { id: "b", title: "B" },
    ]);
    const shown = buildListView(s);
    expect(shown.ids).toEqual([null, "tg", "b"]);
  });
  it("V2: tapping a resumable foreign row enters it and sends sessions.switch (handoff)", () => {
    const s = listWith([
      { id: "tg-1", title: "Telegram chat", foreign: true, platform: "telegram" },
      { id: "b", title: "B" },
    ]);
    const shown = buildListView(s);
    const r = dispatch(s, "click", 1, shown);
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBe("tg-1");
    expect(r.state.history.loadingFor).toBe("tg-1");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("tg-1") }]);
  });
  it("defense-in-depth: a read_only id in a stale snapshot still opens locally without switch", () => {
    const s = listWith([
      { id: "ro", title: "Telegram session", read_only: true },
      { id: "b", title: "B" },
    ]);
    const staleRoSnapshot = { ids: [null, "ro"] };
    const r = dispatch(s, "click", 1, staleRoSnapshot);
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBe("ro");
    expect(r.state.readonlyNoHistory).toBe(true);
    expect(r.effects).toEqual([]);

    // Switching to an owned session clears readonlyNoHistory
    const r2 = dispatch(r.state, "doubleClick"); // back to list
    expect(r2.state.screen).toBe("list");
    const r3 = dispatch(r2.state, "click", 1); // index 1 is now "b" (own only)
    expect(r3.state.sessions.active).toBe("b");
    expect(r3.state.readonlyNoHistory).toBe(false);
  });
  it("keeps active id and prevents mic when sessions frame arrives during read-only view", () => {
    const listState = listWith([
      { id: "ro", title: "Telegram session", read_only: true },
      { id: "owned", title: "Owned session", read_only: false },
    ]);
    const staleRoSnapshot = { ids: [null, "ro"] };
    const r1 = dispatch(listState, "click", 1, staleRoSnapshot);
    expect(r1.state.screen).toBe("session");
    expect(r1.state.sessions.active).toBe("ro");
    expect(r1.state.readonlyNoHistory).toBe(true);

    // Dispatch a sessions frame with active=<owned-id> (e.g. after reconnect)
    const afterReconnect = reduce(r1.state, {
      t: "sessions",
      items: [
        { id: "ro", title: "Telegram session", read_only: true, updated: 0 },
        { id: "owned", title: "Owned session", read_only: false, updated: 0 },
      ],
      active: "owned",
    });
    expect(afterReconnect.sessions.active).toBe("ro");
    expect(afterReconnect.readonlyNoHistory).toBe(true);

    // Click on session screen -> must NOT go to recording, no startMic effect
    const rClick = dispatch(afterReconnect, "click");
    expect(rClick.state.phase).toBe("idle");
    expect(rClick.effects).toEqual([]);

    // Back to list, then switch to owned session (own-only list: index 1)
    const rList = dispatch(afterReconnect, "doubleClick");
    expect(rList.state.screen).toBe("list");
    const rSwitch = dispatch(rList.state, "click", 1);
    expect(rSwitch.state.sessions.active).toBe("owned");
    expect(rSwitch.state.readonlyNoHistory).toBe(false);
    expect(rSwitch.effects).toEqual([{ kind: "send", frame: sessionsSwitch("owned") }]);

    // Mic is allowed again in the owned session
    const rMic = dispatch({ ...rSwitch.state, conn: "connected" }, "click");
    expect(rMic.state.phase).toBe("recording");
    expect(rMic.effects).toEqual([{ kind: "startMic" }]);
  });
  it("double-press exits the app", () => {
    const r = dispatch(listWith([]), "doubleClick");
    expect(r.effects).toEqual([{ kind: "exit" }]);
    expect(r.state.screen).toBe("list");
  });
  it("A3: long-press with ＋New highlighted sends exactly one sessions.new", () => {
    const r = dispatch(listWith([{ id: "a", title: "A" }]), "longPress", 0);
    expect(r.state.screen).toBe("session");
    expect(r.state.expectingNewSession).toBe(true);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("long-press with no row info starts a new session (no row info ≡ ＋New, proto3)", () => {
    const r = dispatch(listWith([{ id: "a", title: "A" }]), "longPress", undefined);
    expect(r.state.screen).toBe("session");
    expect(r.state.expectingNewSession).toBe(true);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("A3: double-tap with ＋New highlighted sends exactly one sessions.new", () => {
    const r = dispatch(listWith([{ id: "a", title: "A" }]), "doubleClick", 0);
    expect(r.state.expectingNewSession).toBe(true);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("A4: double-tap with no row info or on a session row exits, even while loading", () => {
    expect(dispatch(listWith([{ id: "a", title: "A" }]), "doubleClick", 1).effects).toEqual([{ kind: "exit" }]);
    expect(dispatch(listWith([{ id: "a", title: "A" }]), "doubleClick", undefined).effects).toEqual([{ kind: "exit" }]);
    expect(dispatch(initialState(), "doubleClick", 0).effects).toEqual([{ kind: "exit" }]);
  });
  it("scroll is a no-op on the list", () => {
    const r = dispatch(listWith([{ id: "a", title: "A" }]), "scrollUp");
    expect(r.effects).toEqual([]);
    expect(r.state.screen).toBe("list");
  });
  it("unresolved list selection does not create a new session", () => {
    const r = dispatch(listWith([{ id: "a", title: "A" }]), "click", -1);
    expect(r.state.screen).toBe("list");
    expect(r.effects).toEqual([]);
  });

  it("V2: a stale row whose session is now foreign still switches (handoff target)", () => {
    // The displayed snapshot still maps row 1 to a session that a fresh
    // sessions frame has since marked foreign (without read_only) — a listed
    // foreign row is a legitimate cross-surface handoff target now.
    const displayed = listWith([{ id: "was-mine", title: "Was mine", updated: 2 }]);
    const shown = buildListView(displayed);
    const nowForeign = listWith([
      { id: "was-mine", title: "Was mine", updated: 2, foreign: true },
      { id: "b", title: "B", updated: 1 },
    ]);
    const r = dispatch(nowForeign, "click", 1, shown);
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBe("was-mine");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("was-mine") }]);
  });
  it("ignores a tap on a stale row whose session no longer exists (F5)", () => {
    const displayed = listWith([{ id: "gone", title: "Gone", updated: 2 }]);
    const shown = buildListView(displayed);
    const shrunk = listWith([{ id: "b", title: "B", updated: 1 }]);
    const r = dispatch(shrunk, "click", 1, shown);
    expect(r.state.screen).toBe("list");
    expect(r.effects).toEqual([]);
  });
  it("still switches for a displayed row that is own in the live list (F5)", () => {
    const displayed = listWith([{ id: "a", title: "A", updated: 2 }]);
    const shown = buildListView(displayed);
    const r = dispatch(displayed, "click", 1, shown);
    expect(r.state.sessions.active).toBe("a");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("a") }]);
  });
  it("the +New gesture arms the just-created-session claim so the next active frame is ours (F3)", () => {
    const r = dispatch(listWith([]), "longPress", 0);
    expect(r.state.expectingNewSession).toBe(true);
    const claimed = reduce(r.state, { t: "active", id: "fresh-9" });
    expect(claimed.unconfirmedOwnId).toBe("fresh-9");
  });
});

function session(phase: AppState["phase"]): AppState {
  return { ...initialState(), screen: "session", phase, conn: "connected" };
}

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

function gated(overrides?: Partial<AppState>): AppState {
  return {
    ...session("idle"),
    prompts: [prompt()],
    promptHighlight: 1, // deny, the default
    ...overrides,
  };
}

describe("dispatch: prompt gate (A7/A12)", () => {
  it("scroll moves the highlight, clamped at both ends", () => {
    const r1 = dispatch(gated(), "scrollUp");
    expect(r1.state.promptHighlight).toBe(0);
    expect(r1.state.scrollPage).toBeNull();
    const r2 = dispatch(r1.state, "scrollUp");
    expect(r2.state.promptHighlight).toBe(0); // clamped
    const r3 = dispatch(r1.state, "scrollDown");
    expect(r3.state.promptHighlight).toBe(1);
    const r4 = dispatch(r3.state, "scrollDown");
    expect(r4.state.promptHighlight).toBe(1); // clamped at n-1
    expect(r4.effects).toEqual([]);
  });

  it("a tap answers the highlighted option and removes the prompt locally", () => {
    const r = dispatch(gated(), "click");
    expect(r.effects).toEqual([{ kind: "send", frame: promptResponse("p1", "deny") }]);
    expect(r.state.prompts).toEqual([]);
    expect(r.state.promptHighlight).toBe(0);
    const r0 = dispatch({ ...gated(), promptHighlight: 0 }, "click");
    expect(r0.effects).toEqual([{ kind: "send", frame: promptResponse("p1", "once") }]);
  });

  it("a double-tap answers the default option immediately, wherever the highlight is", () => {
    const r = dispatch({ ...gated(), promptHighlight: 0 }, "doubleClick");
    expect(r.effects).toEqual([{ kind: "send", frame: promptResponse("p1", "deny") }]);
    expect(r.state.prompts).toEqual([]);
  });

  it("long-press does nothing while the gate is active", () => {
    const r = dispatch(gated(), "longPress");
    expect(r.effects).toEqual([]);
    expect(r.state.prompts.map((p) => p.id)).toEqual(["p1"]);
    expect(r.state.screen).toBe("session");
  });

  it("answering the head reveals the next prompt and resets the highlight to its default", () => {
    const s = gated({
      prompts: [prompt(), prompt({
        id: "p2",
        options: [
          { id: "edit", label: "Edit first", style: "" },
          { id: "run", label: "Run", style: "primary", default: true },
        ],
      })],
    });
    const r = dispatch(s, "click"); // answers p1 (deny)
    expect(r.effects).toEqual([{ kind: "send", frame: promptResponse("p1", "deny") }]);
    expect(r.state.prompts.map((p) => p.id)).toEqual(["p2"]);
    expect(r.state.promptHighlight).toBe(1); // p2's default ("run")
  });

  it("the gate is off outside idle/review: gestures keep their meaning and the panel stays", () => {
    const r = dispatch(gated({ phase: "recording" }), "click");
    expect(r.state.phase).toBe("transcribing");
    expect(r.effects).toEqual([{ kind: "stopMic" }]);
    expect(r.state.prompts.map((p) => p.id)).toEqual(["p1"]);
  });

  it("in review the gate takes the tap: the transcript stays pending", () => {
    const s = gated({ phase: "review", pending: { transcript: "hello" } });
    const r = dispatch(s, "click");
    expect(r.effects).toEqual([{ kind: "send", frame: promptResponse("p1", "deny") }]);
    expect(r.state.pending).toEqual({ transcript: "hello" });
    expect(r.state.prompts).toEqual([]);
  });

  it("A12: every answer is one of the offered option ids", () => {
    const p = prompt({
      id: "px",
      options: [
        { id: "once", label: "Approve once", style: "primary" },
        { id: "later", label: "Ask again later", style: "" },
        { id: "deny", label: "Deny", style: "danger", default: true },
      ],
    });
    const ids = p.options.map((o) => o.id);
    for (let h = 0; h < p.options.length; h++) {
      for (const g of ["click", "doubleClick"] as const) {
        const r = dispatch(gated({ prompts: [p], promptHighlight: h }), g);
        const sends = r.effects.filter((e) => e.kind === "send");
        expect(sends).toHaveLength(1);
        const frame = JSON.parse((sends[0] as { kind: "send"; frame: string }).frame);
        expect(frame.t).toBe("prompt.response");
        expect(ids).toContain(frame.choice);
      }
    }
  });
});

describe("dispatch: session idle", () => {
  it("tap starts recording", () => {
    const r = dispatch({ ...session("idle"), scrollPage: 3 }, "click");
    expect(r.state.phase).toBe("recording");
    expect(r.state.scrollPage).toBeNull();
    expect(r.effects).toEqual([{ kind: "startMic" }]);
  });
  it("idle tap while offline shows a notice and does not start the mic", () => {
    const r = dispatch({ ...session("idle"), conn: "reconnecting" }, "click");
    expect(r.state.phase).toBe("idle");
    expect(r.state.notice).toBe("offline · reconnecting…");
    expect(r.effects).toEqual([]);
  });
  it("double-press returns to the list", () => {
    const r = dispatch(session("idle"), "doubleClick");
    expect(r.state.screen).toBe("list");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsList() }]);
  });
  it("ignores click and emits no startMic effect when active session is read_only", () => {
    const roSession: AppState = {
      ...session("idle"),
      sessions: {
        items: [{ id: "tg-1", title: "🔒 TG", updated: 10, read_only: true }],
        active: "tg-1",
      },
    };
    const r = dispatch(roSession, "click");
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([]);
    const r2 = dispatch(roSession, "doubleClick");
    expect(r2.state.screen).toBe("list");
  });
  it("blocks the mic when the active session is foreign without read_only (F3)", () => {
    const foreignSession: AppState = {
      ...session("idle"),
      sessions: {
        items: [{ id: "tg-1", title: "Telegram", updated: 10, foreign: true }],
        active: "tg-1",
      },
    };
    const r = dispatch(foreignSession, "click");
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([]);
  });
  it("allows the mic for our just-created session before any list confirms it (F3)", () => {
    const freshSession: AppState = {
      ...session("idle"),
      unconfirmedOwnId: "fresh-9",
      sessions: { items: [{ id: "old", title: "Old", updated: 1 }], active: "fresh-9" },
    };
    const r = dispatch(freshSession, "click");
    expect(r.state.phase).toBe("recording");
    expect(r.effects).toEqual([{ kind: "startMic" }]);
  });
  it("blocks the mic for an active id that is neither listed own nor our fresh session (F3)", () => {
    const unknownActive: AppState = {
      ...session("idle"),
      sessions: { items: [{ id: "old", title: "Old", updated: 1 }], active: "who-knows" },
    };
    const r = dispatch(unknownActive, "click");
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([]);
  });
  it("idle tap on a dead connection asks for a check instead of promising a reconnect (F9b)", () => {
    const r = dispatch({ ...session("idle"), conn: "error: bridge token rejected" }, "click");
    expect(r.state.phase).toBe("idle");
    expect(r.state.notice).toBe("offline · check connection");
    expect(r.effects).toEqual([]);
  });
});

describe("dispatch: session recording", () => {
  it("tap stops + moves to transcribing", () => {
    const r = dispatch(session("recording"), "click");
    expect(r.state.phase).toBe("transcribing");
    expect(r.effects).toEqual([{ kind: "stopMic" }]);
  });
  it("double-press cancels back to idle (still stops the mic)", () => {
    const r = dispatch(session("recording"), "doubleClick");
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([{ kind: "stopMic" }]);
  });
});

function review(transcript: string): AppState {
  return { ...initialState(), screen: "session", phase: "review", conn: "connected", pending: { transcript } };
}

describe("dispatch: session review", () => {
  it("tap sends: pushes a user item with id and pending delivery, clears pending, thinks", () => {
    const r = dispatch(review("add dark mode"), "click", undefined, undefined, () => "turn-123");
    expect(r.state.stream).toEqual([
      { kind: "user", text: "add dark mode", id: "turn-123", delivery: "pending" },
    ]);
    expect(r.state.pending).toBeNull();
    expect(r.state.phase).toBe("idle");
    expect(r.state.turn).toBe("thinking");
    expect(r.effects).toEqual([{ kind: "send", frame: textMsg("add dark mode", "turn-123") }]);
  });
  it("resends the same instruction with same id when idle and last instruction delivery is uncertain", () => {
    const s: AppState = {
      ...initialState(),
      screen: "session",
      phase: "idle",
      conn: "connected",
      turn: "idle",
      stream: [{ kind: "user", text: "retry this", id: "turn-retry", delivery: "uncertain" }],
    };
    const r = dispatch(s, "click");
    expect(r.state.phase).toBe("idle");
    expect(r.state.turn).toBe("thinking");
    expect(r.state.stream).toEqual([
      { kind: "user", text: "retry this", id: "turn-retry", delivery: "pending" },
    ]);
    expect(r.effects).toEqual([{ kind: "send", frame: textMsg("retry this", "turn-retry") }]);
  });
  it("swipe-down redoes: clears pending, no send, stream untouched", () => {
    const r = dispatch(review("oops"), "scrollDown");
    expect(r.state.pending).toBeNull();
    expect(r.state.phase).toBe("idle");
    expect(r.state.stream).toEqual([]);
    expect(r.effects).toEqual([]);
  });
  it("double-press discards and stays in the conversation (list stays behind a second double-press)", () => {
    const r = dispatch(review("oops"), "doubleClick");
    expect(r.state.screen).toBe("session");
    expect(r.state.pending).toBeNull();
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([]);
  });
  it("tap send resets scroll to follow mode (null)", () => {
    const r = dispatch({ ...review("hello"), scrollPage: 3 }, "click");
    expect(r.state.scrollPage).toBeNull();
  });
  it("tap send while offline keeps the transcript and explains instead (F8)", () => {
    const r = dispatch({ ...review("add dark mode"), conn: "reconnecting" }, "click");
    expect(r.state.pending).toEqual({ transcript: "add dark mode" });
    expect(r.state.phase).toBe("review");
    expect(r.state.notice).toBe("offline · reconnecting…");
    expect(r.effects).toEqual([]);
  });
  it("tap send on a dead connection asks for a check instead (F8/F9b)", () => {
    const r = dispatch({ ...review("add dark mode"), conn: "disconnected" }, "click");
    expect(r.state.pending).toEqual({ transcript: "add dark mode" });
    expect(r.state.notice).toBe("offline · check connection");
    expect(r.effects).toEqual([]);
  });
});

describe("dispatch: session transcribing", () => {
  it("double-press escapes a stuck transcribing back to idle", () => {
    const r = dispatch(session("transcribing"), "doubleClick");
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toEqual([]);
  });
  it("tap/scroll are no-ops while transcribing", () => {
    expect(dispatch(session("transcribing"), "click").state.phase).toBe("transcribing");
    expect(dispatch(session("transcribing"), "scrollDown").effects).toEqual([]);
  });
});

function longSession(): AppState {
  const big = "x".repeat(800); // multiple measured viewport windows
  return {
    ...initialState(),
    screen: "session",
    phase: "idle",
    stream: [{ kind: "user", text: "hi" }, { kind: "assistant", text: big }],
  };
}

describe("dispatch: session idle scrolling", () => {
  it("scrollUp from follow moves to the previous measured viewport", () => {
    const pages = threadPages(longSession().stream);
    const r = dispatch(longSession(), "scrollUp");
    expect(r.state.scrollPage).toBe(pages.length - 2);
    expect(r.effects).toEqual([]);
  });
  it("scrollUp clamps at the first viewport", () => {
    const r = dispatch({ ...longSession(), scrollPage: 0 }, "scrollUp");
    expect(r.state.scrollPage).toBe(0);
  });
  it("scrollDown to the latest viewport resumes follow (null)", () => {
    const pages = threadPages(longSession().stream);
    const r = dispatch({ ...longSession(), scrollPage: pages.length - 2 }, "scrollDown");
    expect(r.state.scrollPage).toBeNull();
  });
  it("scrollDown while already following is a no-op", () => {
    const r = dispatch({ ...longSession(), scrollPage: null }, "scrollDown");
    expect(r.state.scrollPage).toBeNull();
  });
  it("scrollUp on a single-page stream stays in follow mode (no-op)", () => {
    const s: AppState = {
      ...initialState(), screen: "session", phase: "idle",
      stream: [{ kind: "user", text: "hi" }],
    };
    const r = dispatch(s, "scrollUp");
    expect(r.state.scrollPage).toBeNull();
  });
});

describe("a tap resolves against the rows on screen", () => {
  // The glasses report a tap as an INDEX into what they are displaying, and the
  // list re-sorts by recency whenever a `sessions` frame lands. Resolving that
  // index against live state opens whatever moved into the slot.
  it("opens the row the wearer touched, even after the list re-sorts", () => {
    const before = listWith([
      { id: "a", title: "A", updated: 200 },
      { id: "b", title: "B", updated: 100 },
    ]);
    const shown = buildListView(before);
    expect(shown.ids).toEqual([null, "a", "b"]);

    // A `sessions` frame lands and B is now the most recent.
    const after = listWith([
      { id: "a", title: "A", updated: 200 },
      { id: "b", title: "B", updated: 300 },
    ]);

    // Row 1 still shows A on screen.
    expect(dispatch(after, "click", 1, shown).effects).toEqual([
      { kind: "send", frame: sessionsSwitch("a") },
    ]);
    // Without the snapshot it resolves against live state and opens B.
    expect(dispatch(after, "click", 1).effects).toEqual([
      { kind: "send", frame: sessionsSwitch("b") },
    ]);
  });
});

describe("resumeOnBoot", () => {
  const items = [
    { id: "tg", title: "Telegram", updated: 900, foreign: true },
    { id: "new", title: "Newest own", updated: 300 },
    { id: "old", title: "Older own", updated: 100 },
  ];
  function bootState(active: string | null): AppState {
    return { ...initialState(), sessionsLoaded: true, sessions: { items, active } };
  }

  it("lands in the conversation screen and switches to the bridge-active own session", () => {
    const r = resumeOnBoot(bootState("old"), null);
    expect(r.state.screen).toBe("session");
    expect(r.state.phase).toBe("idle");
    expect(r.state.sessions.active).toBe("old");
    expect(r.state.history.loadingFor).toBe("old");
    expect(r.state.stream).toEqual([]);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("old") }]);
  });
  it("falls back to the persisted own session when the bridge active id is foreign", () => {
    const r = resumeOnBoot(bootState("tg"), "old");
    expect(r.state.sessions.active).toBe("old");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("old") }]);
  });
  it("resumes the most recent own session when nothing usable is persisted", () => {
    const r = resumeOnBoot(bootState(null), null);
    expect(r.state.sessions.active).toBe("new");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("new") }]);
  });
  it("creates exactly one new session when no own session exists", () => {
    const r = resumeOnBoot(
      {
        ...initialState(),
        sessionsLoaded: true,
        sessions: { items: [{ id: "tg", title: "Telegram", updated: 9, foreign: true }], active: "tg" },
      },
      "tg",
    );
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBeNull();
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("does not re-send the switch when the reconnect re-pin already loaded this session", () => {
    const r = resumeOnBoot({ ...bootState("old"), history: { loadingFor: "old", failedFor: null, refresh: false } }, null);
    expect(r.state.sessions.active).toBe("old");
    expect(r.state.history.loadingFor).toBe("old");
    expect(r.effects).toEqual([]);
  });
});

describe("recoverUnavailableSession (F7)", () => {
  const items = [
    { id: "failed", title: "Failed", updated: 30 },
    { id: "next", title: "Next newest own", updated: 20 },
    { id: "older", title: "Older own", updated: 10 },
    { id: "tg", title: "Telegram", updated: 99, foreign: true },
  ];
  function loading(failedId: string, alreadyFailed: string | null = null): AppState {
    return {
      ...initialState(),
      screen: "session",
      sessions: { items, active: failedId },
      history: { loadingFor: failedId, failedFor: alreadyFailed, refresh: false },
      stream: [{ kind: "user", text: "stale" }],
    };
  }

  it("falls back to the most recent other own session and says why", () => {
    const r = recoverUnavailableSession(loading("failed"), "failed");
    expect(r.state.sessions.active).toBe("next");
    expect(r.state.screen).toBe("session");
    expect(r.state.history.failedFor).toBe("failed");
    expect(r.state.history.loadingFor).toBe("next");
    expect(r.state.stream).toEqual([]);
    expect(r.state.notice).toBe("couldn't open that session");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("next") }]);
  });
  it("a second, different failure goes straight to a fresh session (no ping-pong)", () => {
    // "next" failed first (recorded in failedFor); now "failed" failed too —
    // hopping to "older" would just invite a third switch into a bad list.
    const r = recoverUnavailableSession(loading("failed", "next"), "failed", "next");
    expect(r.state.sessions.active).toBeNull();
    expect(r.state.expectingNewSession).toBe(true);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
  it("creates a new session when nothing own is left to fall back to", () => {
    const onlyFailed = recoverUnavailableSession(
      {
        ...initialState(),
        screen: "session",
        sessions: { items: [{ id: "failed", title: "Only", updated: 1 }], active: "failed" },
        history: { loadingFor: "failed", failedFor: null, refresh: false },
      },
      "failed",
    );
    expect(onlyFailed.state.sessions.active).toBeNull();
    expect(onlyFailed.state.expectingNewSession).toBe(true);
    expect(onlyFailed.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });
});
