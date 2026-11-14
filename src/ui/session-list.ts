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
 * V3.1 W3: collapse live-linked conversation legs into one row. Only a cid the
 * app LEARNED from a mirror frame groups its rows (`mirrorCids`, cid → the row
 * that received the frame): that row becomes the merged row — its id, title
 * and origin stay (so tapping opens the current leg) while `updated` takes the
 * group's newest member, keeping the conversation at its latest-activity spot.
 *
 * Fail-soft by construction: an empty map, a cid matching no row, or a group
 * whose receiving row is absent (or no longer carries the cid) merges nothing,
 * so non-mirrored sessions — including V2 handoff pairs that share a
 * conversation_id without a live link — render exactly as before.
 */
export function mergeMirrorLegs(
  items: SessionItem[],
  mirrorCids: Record<string, string>,
): SessionItem[] {
  const keys = Object.keys(mirrorCids);
  if (keys.length === 0) return items;

  const receiverOf = new Map(items.map((i) => [i.id, i] as const));
  // A cid can group rows only when its receiving row is listed and still
  // belongs to that conversation.
  const groupable = new Set(
    keys.filter((cid) => {
      const receiver = receiverOf.get(mirrorCids[cid]);
      return receiver !== undefined && receiver.conversation_id === cid;
    }),
  );
  if (groupable.size === 0) return items;

  const drop = new Set<string>();
  const newestOf = new Map<string, number>();
  for (const item of items) {
    const cid = item.conversation_id;
    if (!cid || !groupable.has(cid)) continue;
    const receiverId = mirrorCids[cid];
    if (item.id === receiverId) continue;
    drop.add(item.id);
    const receiver = receiverOf.get(receiverId)!; // groupable ⇒ present
    newestOf.set(receiverId, Math.max(newestOf.get(receiverId) ?? receiver.updated, item.updated));
  }
  if (drop.size === 0) return items;

  return items
    .filter((i) => !drop.has(i.id))
    .map((i) => (newestOf.has(i.id) ? { ...i, updated: newestOf.get(i.id)! } : i));
}

/**
 * The sessions that may appear as list rows, newest first: every non-read-only
 * row — own rows plus resumable foreign rows (V2: a listed foreign row taps
 * into a cross-surface handoff). Rows AND ids derive from this one array, so
 * row i always resolves to ids[i]. `mirrorCids` (V3.1 W3) merges live-linked
 * legs of one conversation into a single row first.
 */
export function listableSessions(
  items: SessionItem[],
  mirrorCids: Record<string, string> = {},
): SessionItem[] {
  return orderedSessions(mergeMirrorLegs(items, mirrorCids).filter((item) => !item.read_only));
}

/**
 * Own (speakable) sessions, newest first — the pool for cold-boot resume and
 * failure recovery. A foreign row must never be auto-entered without an
 * explicit tap (pickResumeSession/recoverUnavailableSession).
 */
export function ownSessions(items: SessionItem[]): SessionItem[] {
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
  return ownSessions(items)[0]?.id ?? null;
}

export function sessionForListIndex(
  items: SessionItem[],
  index: number,
  mirrorCids: Record<string, string> = {},
): SessionItem | undefined {
  if (index <= 0) return undefined;
  return listableSessions(items, mirrorCids)[index - 1];
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
  mirrorCids: Record<string, string> = {},
): string[] {
  return [
    NEW_SESSION_ROW,
    ...listableSessions(items, mirrorCids).map((item) => formatSessionRow(item, active, nowSeconds)),
  ];
}

/** Firmware-safe ASCII origin tag for foreign rows ([TG]/[EXT]) — the display
 *  font drops emoji glyphs silently, so 🔒/📱 badges render as stray gaps. */
function originTag(item: SessionItem): string {
  if (!item.foreign) return "";
  return item.platform === "telegram" ? "[TG] " : "[EXT] ";
}

export function formatSessionRow(item: SessionItem, active: string | null, nowSeconds: number): string {
  const marker = item.id === active ? "●" : " ";
  const age = compactAge(item.updated, nowSeconds);
  const prefix = `${marker} ${age} `;

  // Older bridges prefix locked titles with 🔒; it renders as nothing on the
  // display, so strip it before tagging.
  const rawTitle = sessionRowTitle(item).replace(/^🔒\s*/, "");
  const title = truncateTitle(
    originTag(item) + rawTitle,
    LIST_ROW_WIDTH_PX - getTextWidth(prefix),
    MAX_ITEM_CHARS - prefix.length,
  );
  return truncateBytes(prefix + title, MAX_ITEM_BYTES);
}

/** Relative age for display ("now", "5m", "3h", "2d") — shared by the glasses
 *  list rows and the phone sessions panel. */
export function compactAge(updated: number, nowSeconds: number): string {
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
