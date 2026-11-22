import { describe, it, expect } from "vitest";
import { initialState, type AppState } from "../src/state/store";
import type { HerdrTerminal } from "../src/herdr/model";
import {
  applyHerdrTerminals,
  closeHerdrSession,
  openHerdrSession,
  setHerdrConn,
  setHerdrRead,
} from "../src/state/herdr";

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

const listState = (): AppState => ({ ...initialState(), sessionsLoaded: true });

describe("feature-off defaults", () => {
  it("initialState carries an off, empty herdr slice (pre-Phase-2 behavior)", () => {
    expect(initialState().herdr).toEqual({ rows: [], conn: "off", detail: null });
  });
});

describe("applyHerdrTerminals", () => {
  it("maps wire terminals into ordered rows", () => {
    const s = applyHerdrTerminals(listState(), [
      terminal({ address: "t1", created_ms: 100_000_000 }),
      terminal({ address: "t2", created_ms: 100_002_000 }),
    ]);
    expect(s.herdr.rows.map((r) => r.address)).toEqual(["t2", "t1"]);
    expect(s.herdr.conn).toBe("off"); // untouched by row updates
  });

  it("drops rows that disappear from the relay list", () => {
    let s = applyHerdrTerminals(listState(), [terminal({ address: "t1" }), terminal({ address: "t2" })]);
    s = applyHerdrTerminals(s, [terminal({ address: "t2" })]);
    expect(s.herdr.rows.map((r) => r.address)).toEqual(["t2"]);
  });

  it("updates a terminal that changed state (live → finished + exit code)", () => {
    let s = applyHerdrTerminals(listState(), [terminal({ address: "t1" })]);
    s = applyHerdrTerminals(s, [terminal({ address: "t1", state: "finished", finished_ms: 5, exit_code: 2 })]);
    expect(s.herdr.rows[0].state).toBe("finished");
    expect(s.herdr.rows[0].exitCode).toBe(2);
  });

  it("refreshes the open detail screen when its terminal changes", () => {
    let s = openHerdrSession(applyHerdrTerminals(listState(), [terminal({ address: "t1" })]), "t1");
    s = applyHerdrTerminals(s, [terminal({ address: "t1", state: "finished", finished_ms: 5, exit_code: 0 })]);
    expect(s.screen).toBe("herdr-session");
    expect(s.herdr.detail?.state).toBe("finished");
    expect(s.herdr.detail?.exitCode).toBe(0);
  });

  it("never touches the hermes session list or active id", () => {
    const base: AppState = {
      ...listState(),
      sessions: { items: [{ id: "h1", title: "H", updated: 1 }], active: "h1" },
    };
    const s = applyHerdrTerminals(base, [terminal()]);
    expect(s.sessions).toEqual(base.sessions);
  });
});

describe("setHerdrConn (silent degradation)", () => {
  it("clears rows when the relay drops, but keeps the open detail text readable", () => {
    let s = applyHerdrTerminals(listState(), [terminal({ address: "t1" })]);
    s = openHerdrSession(s, "t1");
    s = setHerdrRead(s, "t1", "last lines");
    s = setHerdrConn(s, "reconnecting");
    expect(s.herdr.rows).toEqual([]);
    expect(s.herdr.conn).toBe("reconnecting");
    expect(s.herdr.detail?.text).toBe("last lines");
    expect(s.screen).toBe("herdr-session");
  });

  it("sets the status without inventing notices or toasts", () => {
    const s = setHerdrConn(listState(), "connected");
    expect(s.herdr.conn).toBe("connected");
    expect(s.notice).toBeNull();
  });
});

describe("openHerdrSession", () => {
  it("opens the read-only herdr screen for a known terminal", () => {
    const s = openHerdrSession(
      applyHerdrTerminals(listState(), [terminal({ address: "t1", name: "build" })]),
      "t1",
    );
    expect(s.screen).toBe("herdr-session");
    expect(s.herdr.detail).toEqual({
      address: "t1", name: "build", state: "live", exitCode: null, text: "",
    });
  });

  it("ignores an unknown address instead of opening an empty screen", () => {
    const s = applyHerdrTerminals(listState(), [terminal({ address: "t1" })]);
    expect(openHerdrSession(s, "nope")).toBe(s);
  });

  it("does not move the hermes active session", () => {
    const base: AppState = {
      ...listState(),
      sessions: { items: [{ id: "h1", title: "H", updated: 1 }], active: "h1" },
    };
    const s = openHerdrSession(applyHerdrTerminals(base, [terminal()]), "t7");
    expect(s.sessions.active).toBe("h1");
    expect(s.history.loadingFor).toBeNull();
  });
});

describe("setHerdrRead", () => {
  it("stores stripped plain text for the open terminal only", () => {
    let s = applyHerdrTerminals(listState(), [terminal({ address: "t1" })]);
    s = openHerdrSession(s, "t1");
    s = setHerdrRead(s, "t1", "\x1b[32mok\x1b[0m");
    expect(s.herdr.detail?.text).toBe("ok");
    expect(setHerdrRead(s, "other", "nope")).toBe(s);
  });
});

describe("closeHerdrSession", () => {
  it("returns to the list and drops the detail", () => {
    let s = applyHerdrTerminals(listState(), [terminal({ address: "t1" })]);
    s = openHerdrSession(s, "t1");
    const back = closeHerdrSession(s);
    expect(back.screen).toBe("list");
    expect(back.herdr.detail).toBeNull();
  });
});
