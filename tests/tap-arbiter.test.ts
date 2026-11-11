import { describe, it, expect, vi } from "vitest";
import { createTapArbiter } from "../src/input/tap-arbiter";

/** Manually-driven fake timers: nothing fires until the test says so. */
function fakeTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  const scheduled: number[] = [];
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++next;
      scheduled.push(ms);
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id: unknown) => {
      pending.delete(id as number);
    },
    fire: () => {
      const first = pending.entries().next();
      if (!first.done) {
        pending.delete(first.value[0]);
        first.value[1]();
      }
    },
    size: () => pending.size,
    lastScheduledMs: () => scheduled[scheduled.length - 1],
  };
}

describe("createTapArbiter", () => {
  it("a lone click fires onTap after the window", () => {
    const t = fakeTimers();
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const arb = createTapArbiter({ windowMs: 400, onTap, onDoubleTap, timers: t });
    arb.click();
    expect(t.lastScheduledMs()).toBe(400);
    expect(onTap).not.toHaveBeenCalled();
    t.fire();
    expect(onTap).toHaveBeenCalledOnce();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("a click then a double inside the window fires only onDoubleTap", () => {
    const t = fakeTimers();
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const arb = createTapArbiter({ windowMs: 400, onTap, onDoubleTap, timers: t });
    arb.click();
    arb.doubleClick();
    expect(onDoubleTap).toHaveBeenCalledOnce();
    expect(onTap).not.toHaveBeenCalled();
    expect(t.size()).toBe(0); // the pending tap was cancelled
    t.fire();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("a lone double fires onDoubleTap at once", () => {
    const t = fakeTimers();
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const arb = createTapArbiter({ windowMs: 400, onTap, onDoubleTap, timers: t });
    arb.doubleClick();
    expect(onDoubleTap).toHaveBeenCalledOnce();
    expect(onTap).not.toHaveBeenCalled();
    expect(t.size()).toBe(0);
  });

  it("cancel clears a pending tap (nothing fires)", () => {
    const t = fakeTimers();
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const arb = createTapArbiter({ windowMs: 400, onTap, onDoubleTap, timers: t });
    arb.click();
    arb.cancel();
    expect(t.size()).toBe(0);
    t.fire();
    expect(onTap).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});
