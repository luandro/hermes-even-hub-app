import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHistoryWatch } from "../src/state/history-watch";
import { initialState, reduce, type AppState } from "../src/state/store";
import { sessionsNew, sessionsSwitch, type ServerMsg } from "../src/protocol";
import type { Effect } from "../src/input/dispatch";

const TIMEOUT_MS = 6_000;

const own = (id: string, updated = 1) => ({ id, title: `chat ${id}`, updated });

/**
 * Drives the watch the way main.ts wires it: every frame reduces into a live
 * state first, then the watch sees (prevLoadingFor, nextLoadingFor).
 */
function harness(start: AppState) {
  let state = start;
  const sent: Effect[] = [];
  const watch = createHistoryWatch(TIMEOUT_MS, {
    getState: () => state,
    onTransition: (s, effects) => {
      state = s;
      sent.push(...effects);
    },
  });
  const frame = (m: ServerMsg): void => {
    const prev = state.history.loadingFor;
    state = reduce(state, m);
    watch.update(prev, state.history.loadingFor);
  };
  return {
    get state() { return state; },
    sent,
    watch,
    frame,
  };
}

describe("createHistoryWatch: the F7 client-side timeout", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("recovers a cold load that never answers (extraction sanity)", () => {
    const h = harness({
      ...initialState(),
      screen: "session",
      sessions: { items: [own("dead", 9), own("alive", 5)], active: "dead" },
      history: { loadingFor: "dead", failedFor: null, refresh: false },
    });
    h.watch.update(null, "dead");
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(h.state.sessions.active).toBe("alive");
    expect(h.state.history.loadingFor).toBe("alive");
    expect(h.sent).toEqual([{ kind: "send", frame: sessionsSwitch("alive") }]);
  });

  it("a re-pin refresh that never answers keeps the work on screen (N1a)", () => {
    const h = harness({
      ...initialState(),
      screen: "session",
      conn: "connected",
      phase: "review",
      pending: { transcript: "draft me" },
      scrollPage: 1,
      sessions: { items: [own("a", 9), own("b", 1)], active: "a" },
      history: { loadingFor: null, failedFor: null, refresh: false },
      stream: [
        { kind: "user", text: "hi", id: "t1", delivery: "delivered" },
        { kind: "user", text: "unsent", id: "t2", delivery: "uncertain" },
      ],
    });
    // The re-pin's confirming active frame arms the refresh load.
    h.frame({ t: "active", id: "a" });
    expect(h.state.history.refresh).toBe(true);

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(h.state.sessions.active).toBe("a");
    expect(h.state.history.loadingFor).toBeNull();
    expect(h.state.pending).toEqual({ transcript: "draft me" });
    expect(h.state.phase).toBe("review");
    expect(h.state.stream).toHaveLength(2);
    expect(h.state.scrollPage).toBe(1);
    expect(h.state.notice).toBe("history unavailable");
    expect(h.sent).toEqual([]);
  });

  it("a history frame landing after the refresh timeout still merges, not cold-replaces (N1a)", () => {
    const h = harness({
      ...initialState(),
      screen: "session",
      conn: "connected",
      phase: "review",
      pending: { transcript: "draft me" },
      sessions: { items: [own("a", 9)], active: "a" },
      history: { loadingFor: null, failedFor: null, refresh: false },
      stream: [{ kind: "user", text: "hi", id: "t1", delivery: "delivered" }],
    });
    h.frame({ t: "active", id: "a" });
    vi.advanceTimersByTime(TIMEOUT_MS);

    h.frame({
      t: "history",
      id: "a",
      items: [{ kind: "user", text: "hi" }, { kind: "assistant", text: "answer" }],
      ok: true,
    });

    expect(h.state.pending).toEqual({ transcript: "draft me" });
    expect(h.state.phase).toBe("review");
    expect(h.state.stream.some((i) => i.kind === "assistant")).toBe(true);
  });

  it("re-arms after recovery so a fallback that also sticks is escalated (N2)", () => {
    const h = harness({
      ...initialState(),
      screen: "session",
      sessions: { items: [own("dead", 9), own("alive", 5)], active: "dead" },
      history: { loadingFor: "dead", failedFor: null, refresh: false },
    });
    h.watch.update(null, "dead");            // the tap's switch armed this load
    vi.advanceTimersByTime(TIMEOUT_MS);      // "dead" never answers → fallback
    expect(h.state.history.loadingFor).toBe("alive");

    // The fallback's confirming active frame: loadingFor unchanged, so the
    // frame itself arms nothing — only the recovery's re-arm can save this.
    h.frame({ t: "active", id: "alive" });
    expect(h.state.history.refresh).toBe(true); // the trap the stream guard defuses

    vi.advanceTimersByTime(TIMEOUT_MS);      // second stuck load
    // The re-armed timer fired and recovered instead of hanging: the stuck
    // load is replaced and a recovery switch went out. (The active frame
    // cleared failedFor, so recovery picks the other own session rather than
    // escalating to fresh — pre-existing F7 semantics, unchanged here.)
    expect(h.state.history.loadingFor).toBe("dead");
    expect(h.state.sessions.active).toBe("dead");
    expect(h.sent).toContainEqual({ kind: "send", frame: sessionsSwitch("dead") });
    expect(h.state.notice).toBe("couldn't open that session");
  });

  it("a refresh flag over an EMPTY stream (fallback confirmed by active frame) still recovers", () => {
    const h = harness({
      ...initialState(),
      screen: "session",
      sessions: { items: [own("dead", 9), own("alive", 5)], active: "alive" },
      history: { loadingFor: "alive", failedFor: "dead", refresh: true },
    });
    h.watch.update("dead", "alive");
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(h.state.sessions.active).toBeNull();
    expect(h.sent).toContainEqual({ kind: "send", frame: sessionsNew() });
  });
});
