/**
 * Tap arbiter (§C v6 gate): the hardware may deliver a CLICK and then a
 * DOUBLE_CLICK for one physical double-tap. While the prompt gate is active a
 * lone tap means "confirm the highlighted option" and a double-tap means "the
 * default", so the tap is held for `windowMs` and only fires if no
 * DOUBLE_CLICK follows.
 */
export interface TapArbiterTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface TapArbiter {
  /** A CLICK_EVENT arrived. */
  click: () => void;
  /** A DOUBLE_CLICK_EVENT arrived: wins over any pending tap. */
  doubleClick: () => void;
  /** Drop any pending tap (gate closed, prompt answered, head changed). */
  cancel: () => void;
}

export function createTapArbiter(opts: {
  windowMs: number;
  onTap: () => void;
  onDoubleTap: () => void;
  timers?: TapArbiterTimers;
}): TapArbiter {
  const timers: TapArbiterTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let pending: unknown = null;
  const clear = () => {
    if (pending !== null) {
      timers.clearTimeout(pending);
      pending = null;
    }
  };
  return {
    click: () => {
      clear();
      pending = timers.setTimeout(() => {
        pending = null;
        opts.onTap();
      }, opts.windowMs);
    },
    doubleClick: () => {
      clear();
      opts.onDoubleTap();
    },
    cancel: clear,
  };
}
