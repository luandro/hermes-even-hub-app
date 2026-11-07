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

export function sessionForListIndex(items: SessionItem[], index: number): SessionItem | undefined {
  if (index <= 0) return undefined;
  return orderedSessions(items)[index - 1];
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
    ...orderedSessions(items).map((item) => formatSessionRow(item, active, nowSeconds)),
  ];
}

const READ_ONLY_MARKER = " (read-only)";

function truncateTitleToBytes(text: string, maxBytes: number): string {
  if (utf8.encode(text).length <= maxBytes) return text;
  const chars = Array.from(text);
  while (chars.length > 0) {
    chars.pop();
    const candidate = chars.length > 0 ? chars.join("").trimEnd() + ELLIPSIS : "";
    if (utf8.encode(candidate).length <= maxBytes) return candidate;
  }
  return "";
}

export function formatSessionRow(item: SessionItem, active: string | null, nowSeconds: number): string {
  const marker = item.id === active ? "●" : " ";
  const isReadOnly = Boolean(item.read_only);
  const baseTitle = sessionRowTitle(item);
  const readOnlyTag = isReadOnly && !baseTitle.endsWith(READ_ONLY_MARKER) ? READ_ONLY_MARKER : "";

  const age = compactAge(item.updated, nowSeconds);
  let prefix = `${marker} ${age} `;

  if (readOnlyTag) {
    const fullTextWithAge = `${prefix}${baseTitle}${readOnlyTag}`;
    const fullTextNoAge = `${marker} ${baseTitle}${readOnlyTag}`;

    // If title + marker does not fit with age, but fits if we drop the age, drop the age
    const fitsWithAge =
      utf8.encode(fullTextWithAge).length <= MAX_ITEM_BYTES &&
      fits(fullTextWithAge, LIST_ROW_WIDTH_PX, MAX_ITEM_CHARS);

    const fitsNoAge =
      utf8.encode(fullTextNoAge).length <= MAX_ITEM_BYTES &&
      fits(fullTextNoAge, LIST_ROW_WIDTH_PX, MAX_ITEM_CHARS);

    if (!fitsWithAge && fitsNoAge) {
      prefix = `${marker} `;
    }

    // Measure available space for title leaving room for marker
    const availWidth = LIST_ROW_WIDTH_PX - getTextWidth(prefix) - getTextWidth(readOnlyTag);
    const availChars = MAX_ITEM_CHARS - prefix.length - readOnlyTag.length;
    let title = truncateTitle(baseTitle, availWidth, availChars);

    // If byte limit is exceeded, try dropping age if not yet dropped
    let maxTitleBytes = MAX_ITEM_BYTES - utf8.encode(`${prefix}${readOnlyTag}`).length;
    if (utf8.encode(title).length > maxTitleBytes && prefix !== `${marker} `) {
      prefix = `${marker} `;
      const newAvailWidth = LIST_ROW_WIDTH_PX - getTextWidth(prefix) - getTextWidth(readOnlyTag);
      const newAvailChars = MAX_ITEM_CHARS - prefix.length - readOnlyTag.length;
      title = truncateTitle(baseTitle, newAvailWidth, newAvailChars);
      maxTitleBytes = MAX_ITEM_BYTES - utf8.encode(`${prefix}${readOnlyTag}`).length;
    }

    if (utf8.encode(title).length > maxTitleBytes) {
      title = truncateTitleToBytes(title, maxTitleBytes);
    }

    return truncateBytes(`${prefix}${title}${readOnlyTag}`, MAX_ITEM_BYTES);
  }

  const title = truncateTitle(
    baseTitle,
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
