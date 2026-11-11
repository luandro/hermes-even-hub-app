import { resolveListSelection, type ListSelection } from "./router";
import { createTapArbiter, type TapArbiter, type TapArbiterTimers } from "./tap-arbiter";
import type { Gesture } from "./dispatch";

export interface ListGesturesDeps {
  windowMs: number;
  /** §C gate: while active, click/double belong to the prompt arbiter. */
  promptGateActive: () => boolean;
  /** The prompt-gate arbiter (click/doubleClick only). */
  promptTap: Pick<TapArbiter, "click" | "doubleClick">;
  /** True while the session list is the screen being gestured at. */
  onListScreen: () => boolean;
  /** Row titles currently on screen (selection-name resolution, F10). */
  rows: () => string[];
  /** Apply a resolved gesture (main.ts's applyGesture). */
  apply: (g: Gesture, index?: number) => void;
  timers?: TapArbiterTimers;
}

export interface ListGestures {
  onClick: (selection?: ListSelection) => void;
  onDoubleClick: (selection?: ListSelection) => void;
  onLongPress: (selection?: ListSelection) => void;
  onScrollUp: () => void;
  onScrollDown: () => void;
  /** Drop any held click (prompt head changed, socket dropped, teardown). */
  cancel: () => void;
}

/**
 * List-screen tap arbitration. The hardware may deliver one physical
 * double-tap as CLICK then DOUBLE_CLICK. On the ＋New row that would run
 * A1's open-current on the click half and exit on the double half — the
 * A3 create would never fire. So a click on ＋New (or with no row info) is
 * held for the same window: the double half wins, a lone tap still opens
 * the current session (A1) after the window.
 */
export function createListGestures(deps: ListGesturesDeps): ListGestures {
  let heldClickPending = false;
  // The row the DOUBLE half itself carries, resolved at event time — never
  // inherited from the held click.
  let pendingDoubleIndex: number | undefined;
  const listTapArbiter = createTapArbiter({
    windowMs: deps.windowMs,
    timers: deps.timers,
    onTap: () => {
      heldClickPending = false;
      deps.apply("click", 0);
    },
    onDoubleTap: () => {
      heldClickPending = false;
      deps.apply("doubleClick", pendingDoubleIndex);
    },
  });
  // A held click must never fire after another gesture (or teardown) has
  // taken over: its timer would dispatch a click onto whatever screen the
  // wearer already moved to.
  const cancelHeldClick = (): void => {
    heldClickPending = false;
    listTapArbiter.cancel();
  };
  return {
    onClick: (selection) => {
      if (deps.promptGateActive()) {
        deps.promptTap.click();
        return;
      }
      // A name the host reports must be unique on screen — duplicates are
      // ambiguous and the tap is dropped rather than guessed (F10).
      const index = resolveListSelection(selection, deps.rows());
      // Hold a ＋New (or no-row-info) click for the arbiter window so the
      // DOUBLE_CLICK half of the same physical tap can win (A3 over A1).
      if (deps.onListScreen() && (index === undefined || index === 0)) {
        heldClickPending = true;
        listTapArbiter.click();
        return;
      }
      // A session-row click navigates (it opens that session): any held ＋New
      // click is stale from this moment — its timer would dispatch a click 0
      // onto the session screen the wearer just moved to.
      cancelHeldClick();
      deps.apply("click", index);
    },
    // D2: a double-tap needs the row — ＋New highlighted starts a session,
    // no row info (or a session row) exits.
    onDoubleClick: (selection) => {
      if (deps.promptGateActive()) {
        deps.promptTap.doubleClick();
        return;
      }
      // A double inside the window of a held ＋New click is that click's
      // double half, but it resolves its OWN row info: no info (or a
      // session row) exits; only an explicit ＋New row creates (A3).
      if (heldClickPending) {
        pendingDoubleIndex = resolveListSelection(selection, deps.rows());
        listTapArbiter.doubleClick();
        return;
      }
      deps.apply("doubleClick", resolveListSelection(selection, deps.rows()));
    },
    // A long-press or scroll is another navigation gesture: it ends the held
    // click, so the click half of a later physical double-tap can't land on
    // the screen this gesture already left.
    onLongPress: (selection) => {
      cancelHeldClick();
      deps.apply("longPress", resolveListSelection(selection, deps.rows()));
    },
    onScrollUp: () => {
      cancelHeldClick();
      deps.apply("scrollUp");
    },
    onScrollDown: () => {
      cancelHeldClick();
      deps.apply("scrollDown");
    },
    cancel: cancelHeldClick,
  };
}
