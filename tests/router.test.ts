import { describe, it, expect, vi } from "vitest";
import { OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { routeEvent, resolveListSelection } from "../src/input/router";
import type { InputActions } from "../src/input/router";

function makeActions(): InputActions {
  return {
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onLongPress: vi.fn(),
    onScrollUp: vi.fn(),
    onScrollDown: vi.fn(),
  };
}

describe("routeEvent", () => {
  it("fires onClick for CLICK_EVENT via sysEvent", () => {
    const a = makeActions();
    routeEvent({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as any, a);
    expect(a.onClick).toHaveBeenCalledOnce();
    expect(a.onDoubleClick).not.toHaveBeenCalled();
    expect(a.onScrollUp).not.toHaveBeenCalled();
    expect(a.onScrollDown).not.toHaveBeenCalled();
  });

  it("fires onClick for a click delivered with eventType omitted (proto3 zero-omission)", () => {
    // Real host/SDK behavior: CLICK_EVENT is enum ordinal 0, which proto3 omits
    // from JSON. The SDK does NOT default it, so sysEvent arrives with only
    // eventSource and no eventType. This must still route to onClick.
    const a = makeActions();
    routeEvent({ sysEvent: { eventSource: 1 } } as any, a);
    expect(a.onClick).toHaveBeenCalledOnce();
    expect(a.onDoubleClick).not.toHaveBeenCalled();
    expect(a.onScrollUp).not.toHaveBeenCalled();
    expect(a.onScrollDown).not.toHaveBeenCalled();
  });

  it("fires onClick with the selected index for a list-item click with eventType omitted", () => {
    const a = makeActions();
    routeEvent({ listEvent: { currentSelectItemIndex: 3 } } as any, a);
    expect(a.onClick).toHaveBeenCalledWith({ index: 3, name: undefined });
  });

  it("passes the list selected name when the host omits the index", () => {
    const a = makeActions();
    routeEvent({ listEvent: { currentSelectItemName: "  2h build the app" } } as any, a);
    expect(a.onClick).toHaveBeenCalledWith({ index: undefined, name: "  2h build the app" });
  });

  it("fires onDoubleClick for DOUBLE_CLICK_EVENT via sysEvent", () => {
    const a = makeActions();
    routeEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as any, a);
    expect(a.onDoubleClick).toHaveBeenCalledOnce();
    expect(a.onClick).not.toHaveBeenCalled();
    expect(a.onScrollUp).not.toHaveBeenCalled();
    expect(a.onScrollDown).not.toHaveBeenCalled();
  });

  it("passes the list selection to onDoubleClick (D2 needs ＋New vs no-row-info)", () => {
    const a = makeActions();
    routeEvent({ listEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, currentSelectItemIndex: 0 } } as any, a);
    expect(a.onDoubleClick).toHaveBeenCalledWith({ index: 0, name: undefined });
    routeEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as any, a);
    expect(a.onDoubleClick).toHaveBeenLastCalledWith(undefined);
  });

  it("routes LONG_PRESS_EVENT to onLongPress with the list selection", () => {
    const a = makeActions();
    routeEvent({ listEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT, currentSelectItemIndex: 0 } } as any, a);
    expect(a.onLongPress).toHaveBeenCalledOnce();
    expect(a.onLongPress).toHaveBeenCalledWith({ index: 0, name: undefined });
    routeEvent({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } } as any, a);
    expect(a.onLongPress).toHaveBeenLastCalledWith(undefined);
  });

  it("logs one [evt] debug line per gesture event", () => {
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      routeEvent({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 2 } } as any, makeActions());
      expect(dbg).toHaveBeenCalledTimes(1);
      expect(dbg).toHaveBeenCalledWith("[evt]", OsEventTypeList.CLICK_EVENT, { index: 2, name: undefined });
      routeEvent({ sysEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as any, makeActions());
      expect(dbg).toHaveBeenCalledTimes(2);
      routeEvent({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } } as any, makeActions());
      expect(dbg).toHaveBeenCalledTimes(3);
    } finally {
      dbg.mockRestore();
    }
  });

  it("fires onScrollUp for SCROLL_TOP_EVENT via listEvent", () => {
    const a = makeActions();
    routeEvent({ listEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as any, a);
    expect(a.onScrollUp).toHaveBeenCalledOnce();
    expect(a.onClick).not.toHaveBeenCalled();
  });

  it("fires onScrollDown for SCROLL_BOTTOM_EVENT via textEvent", () => {
    const a = makeActions();
    routeEvent({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as any, a);
    expect(a.onScrollDown).toHaveBeenCalledOnce();
    expect(a.onClick).not.toHaveBeenCalled();
  });

  it("fires nothing for an unrelated event type", () => {
    const a = makeActions();
    // FOREGROUND_ENTER_EVENT = 4, not handled
    routeEvent({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } } as any, a);
    expect(a.onClick).not.toHaveBeenCalled();
    expect(a.onDoubleClick).not.toHaveBeenCalled();
    expect(a.onScrollUp).not.toHaveBeenCalled();
    expect(a.onScrollDown).not.toHaveBeenCalled();
  });

  it("fires nothing for an empty event (no sub-events)", () => {
    const a = makeActions();
    routeEvent({} as any, a);
    expect(a.onClick).not.toHaveBeenCalled();
    expect(a.onDoubleClick).not.toHaveBeenCalled();
    expect(a.onScrollUp).not.toHaveBeenCalled();
    expect(a.onScrollDown).not.toHaveBeenCalled();
  });

  it("prefers sysEvent over listEvent when both present", () => {
    const a = makeActions();
    routeEvent({
      sysEvent: { eventType: OsEventTypeList.CLICK_EVENT },
      listEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT },
    } as any, a);
    expect(a.onClick).toHaveBeenCalledOnce();
    expect(a.onDoubleClick).not.toHaveBeenCalled();
  });

  it("routes FOREGROUND_EXIT to onForegroundExit", () => {
    const a = { onClick: vi.fn(), onDoubleClick: vi.fn(), onScrollUp: vi.fn(), onScrollDown: vi.fn(), onForegroundExit: vi.fn(), onForegroundEnter: vi.fn() };
    routeEvent({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } } as any, a);
    expect(a.onForegroundExit).toHaveBeenCalledOnce();
    expect(a.onClick).not.toHaveBeenCalled();
  });

  it("passes the list selected index to onClick", () => {
    const a = { onClick: vi.fn(), onDoubleClick: vi.fn(), onScrollUp: vi.fn(), onScrollDown: vi.fn() };
    routeEvent({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 2 } } as any, a);
    expect(a.onClick).toHaveBeenCalledWith({ index: 2, name: undefined });
  });

  it("routes FOREGROUND_ENTER to onForegroundEnter", () => {
    const a = { onClick: vi.fn(), onDoubleClick: vi.fn(), onScrollUp: vi.fn(), onScrollDown: vi.fn(), onForegroundExit: vi.fn(), onForegroundEnter: vi.fn() };
    routeEvent({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } } as any, a);
    expect(a.onForegroundEnter).toHaveBeenCalledOnce();
  });

  it("does not throw when foreground handlers are omitted", () => {
    const a = { onClick: vi.fn(), onDoubleClick: vi.fn(), onScrollUp: vi.fn(), onScrollDown: vi.fn() };
    expect(() => routeEvent({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } } as any, a)).not.toThrow();
  });
});

describe("resolveListSelection (name → row index)", () => {
  const rows = ["＋ New session", "  2h grocery list", "● 2h gym plan", "  2h grocery list"];

  it("passes a reported index through", () => {
    expect(resolveListSelection({ index: 2, name: undefined }, rows)).toBe(2);
    expect(resolveListSelection({ index: 0 }, rows)).toBe(0);
  });
  it("resolves a unique row name to its index", () => {
    expect(resolveListSelection({ index: undefined, name: "● 2h gym plan" }, rows)).toBe(2);
  });
  it("refuses to guess when two rows show the same name (F10)", () => {
    expect(resolveListSelection({ index: undefined, name: "  2h grocery list" }, rows)).toBe(-1);
  });
  it("unknown names resolve to -1 (tap ignored)", () => {
    expect(resolveListSelection({ index: undefined, name: "no such row" }, rows)).toBe(-1);
  });
  it("no selection at all stays undefined (caller decides the default)", () => {
    expect(resolveListSelection(undefined, rows)).toBeUndefined();
  });
  it("a present selection with no index and no name is row 0 (proto3 dropped the ＋New index)", () => {
    expect(resolveListSelection({ index: undefined, name: undefined }, rows)).toBe(0);
    expect(resolveListSelection({}, rows)).toBe(0);
  });
});
