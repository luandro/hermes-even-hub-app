import { HINTS, isRefreshWithWork, type AppState } from "./store";
import { recoverUnavailableSession, type Effect } from "../input/dispatch";

export interface HistoryWatchDeps {
  /** Live state at fire time — the timeout must decide on what stands NOW. */
  getState(): AppState;
  /** Apply the timeout's state change: run effects, re-render, arm the notice expiry. */
  onTransition(s: AppState, effects: Effect[]): void;
}

/**
 * A history load that has not answered by the timeout is treated as refused
 * (F7): the bridge wedged on the switch, and the bar must not stay at
 * "loading session..." forever. Extracted from main.ts so the timer flow is
 * testable; main only wires getState/onTransition.
 */
export function createHistoryWatch(timeoutMs: number, deps: HistoryWatchDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const update = (prev: string | null, next: string | null): void => {
    if (!next) {
      clear();
      return;
    }
    if (next === prev) return;
    clear();
    const awaited = next;
    timer = setTimeout(() => {
      timer = undefined;
      const s = deps.getState();
      if (s.history.loadingFor !== awaited) return;
      // A re-pin refresh with work on screen (N1a): the session is already
      // open — recovery would wipe the stream, the review draft and the
      // reading position. Stop the bar and say why instead. The refresh flag
      // stays armed so a history that lands even later still merges rather
      // than cold-replacing the kept work.
      if (isRefreshWithWork(s)) {
        deps.onTransition(
          { ...s, history: { ...s.history, loadingFor: null }, notice: HINTS.historyUnavailable },
          [],
        );
        return;
      }
      const r = recoverUnavailableSession(s, awaited, s.history.failedFor);
      deps.onTransition(r.state, r.effects);
      // The fallback's own history load needs its own timer (N2): its
      // confirming active frame keeps loadingFor unchanged (prev === next),
      // so no frame will arm one — without this, a second stuck load hangs
      // the bar on "loading session..." forever.
      update(awaited, r.state.history.loadingFor);
    }, timeoutMs);
  };
  return { update, dispose: clear };
}
