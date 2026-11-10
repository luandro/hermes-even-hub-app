import { getTextWidth } from "@evenrealities/pretext";
import type { SessionItem } from "../protocol";

export const NEW_SESSION_ROW = "＋ New session";
export const LOADING_SESSIONS_ROW = "loading sessions...";

const LIST_ROW_WIDTH_PX = 576;
const SESSION_HEADER_WIDTH_PX = 540;
const MAX_ITEM_CHARS = 64;
const MAX_ITEM_BYTES = 63;
const ELLIPSIS = "…";
const utf8 = new TextEncoder();

function activityTime(updated: number): number {
  return Number.isFinite(updated) ? updated : 0;
}

export function orderedSessions(items: SessionItem[]): SessionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byUpdated = activityTime(b.item.updated) - activityTime(a.item.updated);
      return byUpdated || a.index - b.index;
    })
    .map(({ item }) => item);
}

/** A session the G2 wearer can actually speak into — not Telegram's, not read-only. */
export function isOwnSession(item: SessionItem): boolean {
  return !item.read_only && !item.foreign;
}

/**
 * The sessions that may appear as list rows, newest first. Rows AND ids derive
 * from this one array, so row i always resolves to ids[i].
 */
export function listableSessions(items: SessionItem[]): SessionItem[] {
  return orderedSessions(items.filter(isOwnSession));
}

/** True when the id is in items and flagged foreign/read_only (Telegram-owned). */
export function isKnownForeignSession(items: SessionItem[], id: string | null | undefined): boolean {
  if (!id) return false;
  return items.some((i) => i.id === id && (i.foreign || i.read_only));
}

/** True when the id is in items and is an own (speakable) session. */
export function isKnownOwnSession(items: SessionItem[], id: string | null | undefined): boolean {
  if (!id) return false;
  return items.some((i) => i.id === id && isOwnSession(i));
}

/**
 * Which own session boot resumes into: the bridge's active id if it is own,
 * else the persisted id if it is own and still known, else the most recent own
 * session, else null (caller creates a new session).
 */
export function pickResumeSession(
  items: SessionItem[],
  bridgeActive: string | null,
  persisted: string | null | undefined,
): string | null {
  if (bridgeActive && isKnownOwnSession(items, bridgeActive)) return bridgeActive;
  if (persisted && isKnownOwnSession(items, persisted)) return persisted;
  return listableSessions(items)[0]?.id ?? null;
}

export function sessionForListIndex(items: SessionItem[], index: number): SessionItem | undefined {
  if (index <= 0) return undefined;
  return listableSessions(items)[index - 1];
}

export function displayTitle(title: string): string {
  return title.trim() || "New session";
}

export function sessionRowTitle(item: SessionItem): string {
  const title = displayTitle(item.title);
  if (title !== "New session") return title;

  const suffix = item.id.replace(/[^a-z0-9]/gi, "").slice(-4);
  return suffix ? `${title} ${suffix}` : title;
}

export function truncateTitle(title: string, maxWidth = SESSION_HEADER_WIDTH_PX, maxChars = MAX_ITEM_CHARS): string {
  const text = displayTitle(title);
  if (fits(text, maxWidth, maxChars)) return text;

  let end = text.length;
  while (end > 0) {
    const candidate = text.slice(0, end).trimEnd() + ELLIPSIS;
    if (fits(candidate, maxWidth, maxChars)) return candidate;
    end--;
  }
  return ELLIPSIS;
}

export function sessionListRows(
  items: SessionItem[],
  active: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): string[] {
  return [
    NEW_SESSION_ROW,
    ...listableSessions(items).map((item) => formatSessionRow(item, active, nowSeconds)),
  ];
}

export function formatSessionRow(item: SessionItem, active: string | null, nowSeconds: number): string {
  const marker = item.id === active ? "●" : " ";
  const age = compactAge(item.updated, nowSeconds);
  const prefix = `${marker} ${age} `;

  const title = truncateTitle(
    sessionRowTitle(item),
    LIST_ROW_WIDTH_PX - getTextWidth(prefix),
    MAX_ITEM_CHARS - prefix.length,
  );
  return truncateBytes(prefix + title, MAX_ITEM_BYTES);
}

function compactAge(updated: number, nowSeconds: number): string {
  const seconds = activityTime(updated);
  if (seconds <= 0) return "--";

  const elapsed = Math.max(0, nowSeconds - seconds);
  if (elapsed < 60) return "now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.min(99, Math.floor(elapsed / 86_400))}d`;
}

function fits(text: string, maxWidth: number, maxChars: number): boolean {
  return text.length <= maxChars && getTextWidth(text) <= maxWidth;
}

function truncateBytes(text: string, maxBytes: number): string {
  if (utf8.encode(text).length <= maxBytes) return text;

  const chars = Array.from(text);
  while (chars.length > 0) {
    const candidate = chars.join("").trimEnd() + ELLIPSIS;
    if (utf8.encode(candidate).length <= maxBytes) return candidate;
    chars.pop();
  }
  return "";
}
