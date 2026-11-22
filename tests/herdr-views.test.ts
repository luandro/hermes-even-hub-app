import { describe, it, expect } from "vitest";
import { initialState, type AppState } from "../src/state/store";
import type { HerdrTerminal } from "../src/herdr/model";
import { applyHerdrTerminals, openHerdrSession, setHerdrRead } from "../src/state/herdr";
import { buildListView } from "../src/ui/views";
import { NEW_SESSION_ROW } from "../src/ui/session-list";
import { herdrSessionView } from "../src/ui/herdr-views";

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

// One shared epoch (seconds): herdr created_ms is the ms twin of the same instant.
const E = 1_000_000_000;
const NOW = E + 30;

const mixedState = (): AppState => {
  let s: AppState = {
    ...initialState(),
    sessionsLoaded: true,
    sessions: {
      items: [
        { id: "h-old", title: "Old chat", updated: E + 5 },
        { id: "h-new", title: "New chat", updated: E + 20 },
      ],
      active: null,
    },
  };
  return applyHerdrTerminals(s, [
    terminal({ address: "t-old", created_ms: (E + 2) * 1000 }),
    terminal({ address: "t-new", created_ms: (E + 10) * 1000 }),
  ]);
};

describe("unified list: mixed worlds", () => {
  it("hermes rows keep their rows; herdr rows enter under a section header, newest-first", () => {
    const view = buildListView(mixedState(), NOW);
    expect(view.rows).toEqual([
      NEW_SESSION_ROW,
      "  now New chat",
      "  now Old chat",
      "herdr · 2",
      "◇ now build · live",
      "◇ now build · live",
    ]);
  });

  it("ids are the tagged union: hermes ids, null header, herdr addresses", () => {
    const view = buildListView(mixedState(), NOW);
    expect(view.ids).toEqual([
      null,
      { kind: "hermes", id: "h-new" },
      { kind: "hermes", id: "h-old" },
      null,
      { kind: "herdr", address: "t-new" },
      { kind: "herdr", address: "t-old" },
    ]);
  });

  it("feature OFF (no herdr rows) renders exactly the pre-Phase-2 list", () => {
    const hermesOnly: AppState = {
      ...initialState(),
      sessionsLoaded: true,
      sessions: {
        items: [
          { id: "h-old", title: "Old chat", updated: E + 5 },
          { id: "h-new", title: "New chat", updated: E + 20 },
        ],
        active: null,
      },
    };
    const off = buildListView(hermesOnly, NOW);
    expect(off.rows).toEqual([NEW_SESSION_ROW, "  now New chat", "  now Old chat"]);
    expect(off.ids).toEqual([null, { kind: "hermes", id: "h-new" }, { kind: "hermes", id: "h-old" }]);
  });

  it("a reconnecting relay disappears from the list (Hermes-only degradation)", () => {
    const degraded = { ...mixedState(), herdr: { ...mixedState().herdr, rows: [] } };
    expect(buildListView(degraded, NOW).rows).not.toContain("herdr · 2");
  });
});

describe("herdr session detail view (read-only)", () => {
  const detailState = (): AppState => {
    let s = applyHerdrTerminals(
      { ...initialState(), sessionsLoaded: true },
      [terminal({ address: "t1", name: "server", state: "running" })],
    );
    s = openHerdrSession(s, "t1");
    return setHerdrRead(s, "t1", ["line one", "line two", "line three"].join("\n"));
  };

  it("header names the terminal and state with the herdr marker", () => {
    expect(herdrSessionView(detailState()).header).toBe("◇ server · live");
  });

  it("body shows the tail of the plain text, wrapped — never an input or send surface", () => {
    const { body } = herdrSessionView(detailState());
    expect(body).toContain("line one");
    expect(body).not.toMatch(/input|textarea|button|send/i);
  });

  it("status is read-only; finished rows surface their exit code", () => {
    expect(herdrSessionView(detailState()).status).toBe("read-only");
    let s = applyHerdrTerminals(
      { ...initialState(), sessionsLoaded: true },
      [terminal({ address: "t1", name: "server", state: "finished", finished_ms: 9, exit_code: 3 })],
    );
    s = openHerdrSession(s, "t1");
    expect(herdrSessionView(s).status).toBe("read-only · exit 3");
  });

  it("a long read is clipped to the thread viewport byte budget, newest lines kept", () => {
    const many = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
    let s = applyHerdrTerminals(
      { ...initialState(), sessionsLoaded: true },
      [terminal({ address: "t1", name: "server" })],
    );
    s = openHerdrSession(s, "t1");
    s = setHerdrRead(s, "t1", many);
    const { body } = herdrSessionView(s);
    const utf8 = new TextEncoder();
    expect(utf8.encode(body).length).toBeLessThanOrEqual(960);
    expect(body).toContain("row 199");
    expect(body).not.toContain("row 0\n");
  });

  it("an unread terminal shows a reading hint, not an empty screen", () => {
    let s = applyHerdrTerminals(
      { ...initialState(), sessionsLoaded: true },
      [terminal({ address: "t1", name: "server" })],
    );
    s = openHerdrSession(s, "t1");
    expect(herdrSessionView(s).body).toBe("reading…");
  });
});

describe("page renderer: the herdr-session screen is its own page kind", () => {
  it("builds the 4-container session page and renders through renderHerdrSession", async () => {
    const { createPageRenderer } = await import("../src/ui/render-queue");
    const calls: string[] = [];
    const deps = {
      showLoadingPage: async (): Promise<void> => { calls.push("loading"); },
      showListPage: async (): Promise<void> => { calls.push("list"); },
      showSessionPage: async (): Promise<void> => { calls.push("session-page"); },
      renderSession: async (): Promise<void> => { calls.push("session-render"); },
      renderHerdrSession: async (): Promise<void> => { calls.push("herdr-render"); },
      isBrowsing: () => false,
    };
    const pages = createPageRenderer(deps);
    let s: AppState = { ...initialState(), sessionsLoaded: true };
    s = openHerdrSession(applyHerdrTerminals(s, [terminal({ address: "t1", name: "server" })]), "t1");
    await pages.render(s);
    await new Promise((res) => { setTimeout(res, 0); });
    expect(calls).toEqual(["session-page", "herdr-render"]);
  });
});

