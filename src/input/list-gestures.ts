import { resolveListSelection, type ListSelection } from "./router";
import type { TapArbiter } from "./tap-arbiter";
import type { Gesture } from "./dispatch";

export interface ListGesturesDeps {
  /** §C gate: while active, click/double belong to the prompt arbiter. */
  promptGateActive: () => boolean;
  /** The prompt-gate arbiter (click/doubleClick only). */
  promptTap: Pick<TapArbiter, "click" | "doubleClick">;
  /** Row titles currently on screen (selection-name resolution, F10). */
  rows: () => string[];
  /** Apply a resolved gesture (main.ts's applyGesture). */
  apply: (g: Gesture, index?: number) => void;
}

export interface ListGestures {
  onClick: (selection?: ListSelection) => void;
  onDoubleClick: (selection?: ListSelection) => void;
  onLongPress: (selection?: ListSelection) => void;
  onScrollUp: () => void;
  onScrollDown: () => void;
}

/**
 * List-screen gesture routing. Each gesture resolves its row (F10) and
 * applies immediately — a tap on ＋New (or with no row info) is a
 * sessions.new by the time dispatch sees it, so nothing is deferred to a
 * double-tap window: the first gesture wins. Only the §C prompt gate
 * intercepts click/double first.
 */
export function createListGestures(deps: ListGesturesDeps): ListGestures {
  return {
    onClick: (selection) => {
      if (deps.promptGateActive()) {
        deps.promptTap.click();
        return;
      }
      // A name the host reports must be unique on screen — duplicates are
      // ambiguous and the tap is dropped rather than guessed (F10).
      deps.apply("click", resolveListSelection(selection, deps.rows()));
    },
    // D2: a double-tap needs the row — ＋New highlighted starts a session,
    // no row info (or a session row) exits.
    onDoubleClick: (selection) => {
      if (deps.promptGateActive()) {
        deps.promptTap.doubleClick();
        return;
      }
      deps.apply("doubleClick", resolveListSelection(selection, deps.rows()));
    },
    onLongPress: (selection) => {
      deps.apply("longPress", resolveListSelection(selection, deps.rows()));
    },
    onScrollUp: () => {
      deps.apply("scrollUp");
    },
    onScrollDown: () => {
      deps.apply("scrollDown");
    },
  };
}
