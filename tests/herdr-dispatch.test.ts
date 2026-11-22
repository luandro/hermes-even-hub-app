import { describe, it, expect, expectTypeOf } from "vitest";
import { initialState, type AppState } from "../src/state/store";
import type { AnySessionId, HerdrTerminal } from "../src/herdr/model";
import { applyHerdrTerminals, openHerdrSession } from "../src/state/herdr";
import { dispatch, enterSession, type ListSnapshot } from "../src/input/dispatch";
import { buildListView } from "../src/ui/views";
import { herdrId } from "../src/herdr/model";
import { sessionsSwitch } from "../src/protocol";

const terminal = (over: Partial<HerdrTerminal> = {}): HerdrTerminal => ({
  address: "t7",
  name: "build",
  argv: ["npm", "run", "build"],
  cwd: "/repo",
  state: "running",
  exit_code: null,
  created_ms: 100_000_000,
  finished_ms: null,
  ...over,
});

const mixedList = (): AppState => {
  let s: AppState = {
    ...initialState(),
    sessionsLoaded: true,
    sessions: { items: [{ id: "h1", title: "Chat", updated: 300 }], active: null },
  };
  return applyHerdrTerminals(s, [terminal({ address: "t1" }), terminal({ address: "t2", created_ms: 50 })]);
};

describe("type-level isolation (the safety-critical part)", () => {
  it("a herdr id cannot be passed to the hermes switch frame", () => {
    const herdrOnly = herdrId("t7");
    // @ts-expect-error — AnySessionId herdr member must never reach a Hermes-only op
    sessionsSwitch(herdrOnly);
  });

  it("a herdr id cannot open a hermes session screen", () => {
    const s = initialState();
    // @ts-expect-error — enterSession takes a Hermes session id (string | null)
    enterSession(s, herdrId("t7"));
  });

  it("the list snapshot and view ids expose the tagged union, not bare strings", () => {
    expectTypeOf<ListSnapshot["ids"][number]>().toEqualTypeOf<AnySessionId | null>();
    const view = buildListView(mixedList());
    expectTypeOf<(typeof view.ids)[number]>().toEqualTypeOf<AnySessionId | null>();
  });
});

describe("tapping a herdr row", () => {
  it("opens the read-only herdr screen with NO wire effects and no hermes switch", () => {
    const s = mixedList();
    const shown = buildListView(s);
    const herdrIndex = shown.ids.findIndex((id) => id?.kind === "herdr");
    expect(herdrIndex).toBeGreaterThan(0);

    const r = dispatch(s, "click", herdrIndex, shown);

    expect(r.state.screen).toBe("herdr-session");
    expect(r.state.herdr.detail?.address).toBe("t1");
    expect(r.effects).toEqual([]); // no sessions.switch, no mic, no send — nothing
    expect(r.state.sessions.active).toBeNull();
    expect(r.state.sessionsLoaded).toBe(true);
  });

  it("a herdr address can never leak into sessions.items flows: active id untouched", () => {
    const s = mixedList();
    const shown = buildListView(s);
    const idx = shown.ids.findIndex((id) => id?.kind === "herdr");
    const r = dispatch(s, "click", idx, shown);
    expect(r.state.sessions.items).toEqual([{ id: "h1", title: "Chat", updated: 300 }]);
    expect(r.state.history.loadingFor).toBeNull();
  });

  it("the section header row is a no-op tap", () => {
    const s = mixedList();
    const shown = buildListView(s);
    const headerIndex = shown.rows.findIndex((row) => row.startsWith("herdr ·"));
    const r = dispatch(s, "click", headerIndex, shown);
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([]);
  });
});

describe("the herdr-session screen is read-only by construction", () => {
  const onScreen = (): AppState =>
    openHerdrSession(
      applyHerdrTerminals({ ...initialState(), sessionsLoaded: true }, [terminal({ address: "t1" })]),
      "t1",
    );

  it("click does nothing — no mic, no send, no phase change", () => {
    const r = dispatch(onScreen(), "click");
    expect(r.effects).toEqual([]);
    expect(r.state.phase).toBe("idle");
    expect(r.state.screen).toBe("herdr-session");
  });

  it("long-press does nothing", () => {
    const r = dispatch(onScreen(), "longPress");
    expect(r.effects).toEqual([]);
    expect(r.state.screen).toBe("herdr-session");
  });

  it("double-click is the Back gesture to the list", () => {
    const r = dispatch(onScreen(), "doubleClick");
    expect(r.state.screen).toBe("list");
    expect(r.state.herdr.detail).toBeNull();
  });

  it("scroll gestures never exit or start input", () => {
    for (const g of ["scrollUp", "scrollDown"] as const) {
      const r = dispatch(onScreen(), g);
      expect(r.state.screen).toBe("herdr-session");
      expect(r.effects).toEqual([]);
    }
  });

  it("a hermes tap on the same list still switches hermes sessions", () => {
    const s = mixedList();
    const shown = buildListView(s);
    const r = dispatch(s, "click", 1, shown); // first hermes row after ＋New
    expect(r.state.screen).toBe("session");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("h1") }]);
  });
});
