import { describe, it, expect, vi } from "vitest";
import { createListGestures } from "../src/input/list-gestures";
import { dispatch, type Effect, type Gesture } from "../src/input/dispatch";
import { initialState, type AppState } from "../src/state/store";
import { sessionsNew, sessionsSwitch, sessionsList } from "../src/protocol";

const ROWS = ["＋ New", "Alpha", "Beta"];

function listWith(
  items: { id: string; title: string; updated?: number }[],
): AppState {
  return {
    ...initialState(),
    conn: "connected", // a stray click on the session screen would start the mic
    sessionsLoaded: true,
    sessions: { items: items.map((i) => ({ ...i, updated: i.updated ?? 0 })), active: null },
  };
}

/** The gestures wired to the REAL dispatch over a real list-screen state. */
function setup(state: AppState) {
  const effects: Effect[] = [];
  const promptTap = { click: vi.fn(), doubleClick: vi.fn() };
  let gateActive = false;
  const gestures = createListGestures({
    promptGateActive: () => gateActive,
    promptTap,
    rows: () => ROWS,
    apply: (g: Gesture, index?: number) => {
      const r = dispatch(state, g, index);
      state = r.state;
      effects.push(...r.effects);
    },
  });
  return {
    gestures,
    effects,
    state: () => state,
    promptTap,
    setGate: (v: boolean) => { gateActive = v; },
  };
}

describe("createListGestures (combined hardware sequences)", () => {
  it("a no-info click applies immediately and starts a new session (no held window)", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", updated: 2 }]));
    s.gestures.onClick(undefined); // no row info ≡ ＋New: a tap creates
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    expect(s.state().screen).toBe("session");
    expect(s.state().expectingNewSession).toBe(true);
  });

  it("a row-0 click then row-0 double-click: the click half wins, the double half lands on the session screen", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick({ index: 0 }); // creates and leaves the list
    s.gestures.onDoubleClick({ index: 0 }); // arrives on the session screen: back to list
    expect(s.effects).toEqual([
      { kind: "send", frame: sessionsNew() },
      { kind: "send", frame: sessionsList() },
    ]);
    expect(s.state().screen).toBe("list");
  });

  it("a no-info click then session-row double-click: create, then the double returns to the list", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick(undefined); // creates
    s.gestures.onDoubleClick({ index: 1 }); // double resolves its own row, on the session screen
    expect(s.effects).toEqual([
      { kind: "send", frame: sessionsNew() },
      { kind: "send", frame: sessionsList() },
    ]);
    expect(s.state().screen).toBe("list");
  });

  it("a session-row click applies immediately and opens that session", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick({ index: 1 });
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsSwitch("a") }]);
    expect(s.state().screen).toBe("session");
    expect(s.state().phase).toBe("idle"); // no mic started
  });

  it("a no-row-info long-press starts exactly one new session", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onLongPress(undefined);
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    expect(s.state().screen).toBe("session");
  });

  it("a click followed by a long-press still sends exactly one sessions.new", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.gestures.onClick(undefined); // creates, leaves the list
    s.gestures.onLongPress({ index: 0 }); // long-press on the session screen is a no-op
    expect(s.effects).toEqual([{ kind: "send", frame: sessionsNew() }]);
    expect(s.state().phase).toBe("idle"); // not recording: no mic started
  });

  it("while the prompt gate is active, click/double go to the prompt arbiter", () => {
    const s = setup(listWith([{ id: "a", title: "Alpha" }]));
    s.setGate(true);
    s.gestures.onClick(undefined);
    s.gestures.onDoubleClick(undefined);
    expect(s.promptTap.click).toHaveBeenCalledOnce();
    expect(s.promptTap.doubleClick).toHaveBeenCalledOnce();
    expect(s.effects).toEqual([]);
  });
});
