import { OsEventTypeList } from "@evenrealities/even_hub_sdk";
import type { EvenHubEvent } from "@evenrealities/even_hub_sdk";

export interface InputActions {
  onClick: (selection?: ListSelection) => void;
  onDoubleClick: () => void;
  onScrollUp: () => void;
  onScrollDown: () => void;
  onForegroundEnter?: () => void;
  onForegroundExit?: () => void;
}

export interface ListSelection {
  index?: number;
  name?: string;
}

/**
 * Resolve a list selection to a row index against the rows ON SCREEN.
 *
 * The host sometimes reports only the row NAME (index omitted). Two sessions
 * with the same title and age bucket render identical rows — guessing the
 * first match would open the wrong conversation, so an ambiguous name
 * resolves to -1 (the tap is ignored by dispatch).
 */
export function resolveListSelection(
  selection: ListSelection | undefined,
  visibleRows: string[],
): number | undefined {
  if (!selection) return undefined;
  if (selection.index !== undefined) return selection.index;
  if (selection.name === undefined) return undefined;
  const first = visibleRows.indexOf(selection.name);
  if (first < 0) return -1;
  const duplicate = visibleRows.indexOf(selection.name, first + 1);
  return duplicate >= 0 ? -1 : first;
}

// Pick whichever event object the host populated (these are mutually exclusive
// per EvenHubEventType). CLICK_EVENT is enum ordinal 0, which the host omits
// from JSON (proto3 drops zero-valued scalars) and the SDK does NOT default —
// so a present event with no eventType IS a click. Every other event type is
// non-zero and arrives with its eventType set.
export function routeEvent(e: EvenHubEvent, a: InputActions): void {
  const src = e.sysEvent ?? e.listEvent ?? e.textEvent;
  if (!src) return;
  const et = src.eventType ?? OsEventTypeList.CLICK_EVENT;
  if (et === OsEventTypeList.CLICK_EVENT) {
    a.onClick(e.listEvent ? {
      index: e.listEvent.currentSelectItemIndex,
      name: e.listEvent.currentSelectItemName,
    } : undefined);
  }
  else if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) a.onDoubleClick();
  else if (et === OsEventTypeList.SCROLL_TOP_EVENT) a.onScrollUp();
  else if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) a.onScrollDown();
  else if (et === OsEventTypeList.FOREGROUND_ENTER_EVENT) a.onForegroundEnter?.();
  else if (et === OsEventTypeList.FOREGROUND_EXIT_EVENT) a.onForegroundExit?.();
}
