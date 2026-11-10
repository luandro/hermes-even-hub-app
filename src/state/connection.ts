import { isRefreshWithWork, reduce, type AppState } from "./store";
import { sessionsList, sessionsSwitch, type ServerMsg } from "../protocol";
import { recoverUnavailableSession, resumeOnBoot, type Effect } from "../input/dispatch";
import { isKnownOwnSession } from "../ui/session-list";

/**
 * Connection-level flags owned by the caller (main.ts), threaded through
 * applyServerMessage so the frame sequence itself stays pure and testable.
 *
 * `bootResumeDone` is reset ONLY on a fresh app launch / user-initiated
 * (re)connect — never by hello.ok. A mid-flight reconnect must not re-run the
 * boot resume: enterSession would wipe the stream, a pending review transcript
 * and the delivery state of in-flight turns.
 */
export interface ConnectionFlags {
  helloOk: boolean;
  bootResumeDone: boolean;
}

export interface MessageResult {
  state: AppState;
  /** Frames to send now (re-pin, sessions.list, resume switch/new, recovery). */
  effects: Effect[];
  flags: ConnectionFlags;
  /** True when the boot resume ran on this message (exactly once per launch). */
  resumed: boolean;
  /** A session id that became safe to persist, or null (never clears). */
  persist: string | null;
}

export function applyServerMessage(
  s: AppState,
  m: ServerMsg,
  flags: ConnectionFlags,
  persisted: string | null,
): MessageResult {
  // Captured BEFORE the reduce: hello.ok's reducer must not move the active
  // id, and the re-pin needs the id the wearer actually had.
  const prevActive = s.sessions.active;
  const prevUnconfirmed = s.unconfirmedOwnId;
  const prevLoadingFor = s.history.loadingFor;

  let state = reduce(s, m);
  const effects: Effect[] = [];
  let f = flags;
  let persist: string | null = null;

  if (m.t === "hello.ok") {
    f = { ...f, helloOk: true };
    // Reconnect re-pin: ask the bridge to make OUR session active again — but
    // only when it disagrees, and only for an id that is ours (listed own, or
    // the just-created session no list has confirmed yet).
    const rePin =
      prevActive
      && m.active !== prevActive
      && (isKnownOwnSession(state.sessions.items, prevActive) || prevActive === state.unconfirmedOwnId);
    if (rePin) effects.push({ kind: "send", frame: sessionsSwitch(prevActive) });
    effects.push({ kind: "send", frame: sessionsList() });
  }

  let resumed = false;
  if (m.t === "sessions" && !f.bootResumeDone) {
    f = { ...f, bootResumeDone: true };
    const r = resumeOnBoot(state, persisted);
    state = r.state;
    effects.push(...r.effects);
    resumed = true;
  }

  if (m.t === "sessions"
    && prevUnconfirmed
    && !state.unconfirmedOwnId
    && isKnownOwnSession(state.sessions.items, prevUnconfirmed)) {
    // A newly created session just got listed own: NOW its id is safe to save.
    persist = prevUnconfirmed;
  }

  if (m.t === "active" && isKnownOwnSession(state.sessions.items, m.id)) {
    persist = m.id;
  }

  if (m.t === "error" && prevLoadingFor && !isRefreshWithWork(s)) {
    // The resume switch was refused (or the session is gone): fall back
    // instead of showing "loading session..." forever — EXCEPT during a
    // re-pin refresh with work on screen (N1b): the session is already open,
    // recovery would wipe it, so the notice-only error stands.
    // s.history.failedFor is the PRE-reduce value (the reducer just
    // overwrote it with this failure).
    const r = recoverUnavailableSession(state, prevLoadingFor, s.history.failedFor);
    state = r.state;
    effects.push(...r.effects);
  }

  return { state, effects, flags: f, resumed, persist };
}
