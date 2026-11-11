import { describe, it, expect, vi } from "vitest";
import { createListGestures } from "../src/input/list-gestures";
import { dispatch, type Effect, type Gesture } from "../src/input/dispatch";
import { initialState, type AppState } from "../src/state/store";
import { sessionsNew, sessionsSwitch } from "../src/protocol";

/** Manually-driven fake timers: nothing fires until the test says so. */
function fakeTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++next;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id: unknown) => {
      pending.delete(id as number);
    },
    fire: () => {
      const first = pending.entries().next();
      if (!first.done) {
        pending.delete(first.value[0]);
        first.value[1]();
      }
    },
    size: () => pending.size,
  };
}

const ROWS = ["＋ New", "Alpha", "Beta"];

function listWith(
  items: { id: string; title: string; updated?: number }[],
): AppState {
  return {
    ...initialState(),
    conn: "connected", // a deferred click on the session screen would start the mic
    sessionsLoaded: true,
    sessions: { items: items.map((i) => ({ ...i, updated: i.updated ?? 0 })), active: null },
  };
}

/** The gestures wired to the REAL dispatch over a real list-screen state. */
function setup(state: AppState) {
  const timers = fakeTimers();
  const effects: Effect[] = [];
  const promptTap = { click: vi.fn(), doubleClick: vi.fn() };
  let gateActive = false;
  const gestures = createListGestures({
    windowMs: 400,
    promptGateActive: () => gateActive,
    promptTap,
    onListScreen: () => state.screen === "list",
    rows: () => ROWS,
    apply: (g: Gesture, index?: number) => {
      const r = dispatch(state, g, index);
      state = r.state;
      effects.push(...r.effects);
    },
    timers,
  });
  return {
    gestures,
    timers,
    effects,
    state: () => state,
    promptTap,
    setGate: (v: boolean) => { gateActive = v; },
  };
}

describe("createListGestures (combined hardware sequences)", () => {
  it("held no-info click then no-info double-click exits (never creates a session)", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", updated: 2 }]));
    s.gestures.onClick(undefined); // no row info: held for the window
    s.gestures.onDoubleClick(undefined); // the double half, also no row info
    expect(s.effects).toEqual([{ kind: "exit" }]);
    expect(s.state().screen).toBe("list");
    s.timers.fire(); // nothing deferred may land afterwards
    expect(s.effects).toEqual([{ kind: "exit" }]);
  });

  it("held row-0 click then row-0 double-click creates exactly one session (A3)", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick({ index: 0 });
    s.gestures.onDoubleClick({ index: 0 });
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    s.timers.fire();
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
  });

  it("held no-info click then session-row double-click exits (double resolves its own row)", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick(undefined);
    s.gestures.onDoubleClick({ index: 1 });
    expect(s.effects).toEqual([{ kind: "exit" }]);
    s.timers.fire();
    expect(s.effects).toEqual([{ kind: "exit" }]);
  });

  it("a lone held click expires into open-current (A1)", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", updated: 2 }]));
    s.gestures.onClick(undefined);
    expect(s.effects).toEqual([]);
    s.timers.fire();
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsSwitch("b") }]);
  });

  it("a long-press ends the held click: one sessions.new, no later click on the session screen", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick(undefined); // held
    s.gestures.onLongPress({ index: 0 }); // ＋New long-press: A3 create
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    expect(s.state().screen).toBe("session");
    s.timers.fire(); // the held click must not fire on the session screen
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    expect(s.state().phase).toBe("idle"); // not recording
  });

  it("a scroll ends the held click: no deferred click afterwards", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", updated: 2 }]));
    s.gestures.onClick(undefined); // held
    s.gestures.onScrollUp();
    expect(s.effects).toEqual([]); // scroll on the list sends nothing
    s.timers.fire(); // without the cancel this would open the current session
    expect(s.effects).toEqual([]);
    s.gestures.onScrollDown();
    s.timers.fire();
    expect(s.effects).toEqual([]);
  });

  it("a session-row click ends the held click: no late click on the session screen", () => {
    // The row tap itself navigates (it opens that session), so the held ＋New
    // click is stale from that moment: without the cancel its timer later
    // fires click 0 ON THE SESSION SCREEN — there it would start the mic or
    // answer a prompt.
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick(undefined); // held (no row info)
    s.gestures.onClick({ index: 1 }); // session-row tap: opens Alpha, navigates
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsSwitch("a") }]);
    expect(s.state().screen).toBe("session");
    s.timers.fire(); // the held click must not land on the session screen
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsSwitch("a") }]);
    expect(s.state().phase).toBe("idle"); // not recording: no mic started
  });

  it("while the prompt gate is active, click/double go to the prompt arbiter", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.setGate(true);
    s.gestures.onClick(undefined);
    s.gestures.onDoubleClick(undefined);
    expect(s.promptTap.click).toHaveBeenCalledOnce();
    expect(s.promptTap.doubleClick).toHaveBeenCalledOnce();
    expect(s.timers.size()).toBe(0); // nothing held on the list
    expect(s.effects).toEqual([]);
  });

  it("cancel drops a held click (prompt landed, socket dropped)", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick(undefined);
    s.gestures.cancel();
    s.timers.fire();
    expect(s.effects).toEqual([]);
    expect(s.state().screen).toBe("list");
  });
});
