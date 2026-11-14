import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { AppState, Prompt, StreamItem } from "../state/store";
import { HINTS, barText, connDot, isHistoryLoading } from "../state/store";
import { IDS, setText, showListPage, showLoadingPage } from "./render";
import {
  LOADING_SESSIONS_ROW,
  NEW_SESSION_ROW,
  formatSessionRow,
  listableSessions,
  truncateTitle,
} from "./session-list";
import {
  THREAD_BODY_INNER_WIDTH,
  THREAD_VIEWPORT_LINES,
  currentThreadViewport,
  wrapTextLines,
} from "./stream";

export function truncateRow(title: string): string {
  return truncateTitle(title);
}

/**
 * What is on screen, and what each row MEANS.
 *
 * `rows` and `ids` are built together and must stay together: the glasses report
 * a tap as an INDEX into the rows they are currently displaying, and the session
 * list re-sorts by recency underneath us every time a `sessions` frame arrives.
 * Re-deriving the mapping from live state at tap time therefore opens whatever
 * sits at that index NOW, which after any reorder is not the row the wearer
 * touched.
 *
 * `ids[i]` is the session for row `i`, or null for the ＋New row.
 */
export interface ListView {
  rows: string[];
  ids: (string | null)[];
}

export function buildListView(s: AppState, nowSeconds?: number): ListView {
  if (!s.sessionsLoaded) return { rows: [LOADING_SESSIONS_ROW], ids: [null] };
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  // ONE filtered array feeds both rows and ids: the glasses report a tap as an
  // index into the rows on screen, so ids[i] must be the session rows[i] was
  // drawn from — foreign/read-only sessions never enter the mapping. Mirror-
  // learned cids (V3.1 W3) merge live-linked legs into that same single array.
  const listable = listableSessions(s.sessions.items, s.mirrorCids);
  return {
    rows: [NEW_SESSION_ROW, ...listable.map((item) => formatSessionRow(item, s.sessions.active, now))],
    ids: [null, ...listable.map((item) => item.id)],
  };
}

export function listRows(s: AppState, nowSeconds?: number): string[] {
  return buildListView(s, nowSeconds).rows;
}

export async function renderList(bridge: EvenAppBridge, s: AppState): Promise<void> {
  if (!s.sessionsLoaded) {
    await showLoadingPage(bridge, loadingText(s));
    return;
  }
  // Lists can't update in place — rebuild the page (glasses-ui).
  await showListPage(bridge, listRows(s));
}

export function loadingText(s: AppState): string {
  const status = s.conn === "connected"
    ? "waiting for session list"
    : s.conn;
  return `loading sessions...\n${status}`;
}

/** Command lines, capped at `maxLines`, width-fit with an ellipsis (A6/A11). */
function commandLines(command: string, maxLines: number): string[] {
  if (!command) return [];
  const wrapped = wrapTextLines(command, THREAD_BODY_INNER_WIDTH);
  if (wrapped.length <= maxLines) return wrapped;
  // Shrink with a trailing ellipsis until it fits the line budget.
  let text = `${command}…`;
  while (text.length > 2 && wrapTextLines(text, THREAD_BODY_INNER_WIDTH).length > maxLines) {
    text = `${text.slice(0, -2)}…`;
  }
  return wrapTextLines(text, THREAD_BODY_INNER_WIDTH);
}

/**
 * The prompt panel body (A6): the command on top (≤2 lines), then the options
 * in wire order with a `>` marker on the highlighted one. With 6 options the
 * command shrinks to one line so the whole panel fits the 7-line viewport.
 * Labels are defensively truncated at 24 (A11).
 */
export function promptBody(p: Prompt, highlight: number): string {
  const maxCommand = p.options.length >= THREAD_VIEWPORT_LINES - 1 ? 1 : 2;
  const command = commandLines(p.command, maxCommand);
  const options = p.options.map((o, i) =>
    `${i === highlight ? "> " : "  "}${o.label.slice(0, 24)}`);
  return [...command, ...options].join("\n");
}

/** The prompt panel hint (A6), shown in the status container. */
export function promptHint(p: Prompt): string {
  const def = p.options.find((o) => o.default === true)?.label
    ?? p.options[0]?.label ?? "";
  const base = `scroll=choose · tap=ok · 2×tap=${def}`;
  if (p.timeout_s > 0 && p.timeout_choice) {
    const label = p.options.find((o) => o.id === p.timeout_choice)?.label ?? p.timeout_choice;
    return `${base} · auto ${label} ${p.timeout_s}s`;
  }
  return `${base} · no answer = no`;
}

export async function renderSession(bridge: EvenAppBridge, s: AppState): Promise<void> {
  // A prompt takes over the session screen (A6): title in the header, command
  // + options in the body, the gesture hint (+N queued) in the status bar.
  // The active session and phase are untouched.
  if (s.prompts.length > 0) {
    const p = s.prompts[0];
    const queued = s.prompts.length > 1 ? ` · +${s.prompts.length - 1}` : "";
    await setText(bridge, IDS.header, p.title);
    await setText(bridge, IDS.dot, connDot(s.conn));
    await setText(bridge, IDS.body, promptBody(p, s.promptHighlight));
    await setText(bridge, IDS.status, truncateTitle(promptHint(p) + queued, 576, 64));
    return;
  }

  const active = s.sessions.items.find((i) => i.id === s.sessions.active);
  const rawTitle = active?.title.trim() ?? "";
  await setText(bridge, IDS.header, headerTitle(rawTitle, s));
  await setText(bridge, IDS.dot, connDot(s.conn));

  const body = isHistoryLoading(s)
    ? HINTS.historyLoading
    : displayThreadItems(s).length === 0
      ? (s.readonlyNoHistory ? "" : HINTS.tapToSpeak)
      : threadViewportText(s);
  await setText(bridge, IDS.body, body);

  await setText(bridge, IDS.status, statusText(s));
}

/**
 * sessions.new sessions have no protocol-level title, so an untitled session
 * ("New session" or blank) shows what the wearer first said instead — the only
 * label the client owns without a rename protocol.
 */
function headerTitle(rawTitle: string, s: AppState): string {
  if (rawTitle && rawTitle !== "New session") return truncateRow(rawTitle);
  const firstUser = s.stream.find((it): it is StreamItem & { kind: "user" } => it.kind === "user");
  const snippet = firstUser?.text.trim();
  return snippet ? truncateRow(snippet) : "Hermes";
}

function threadViewportText(s: AppState): string {
  return currentThreadViewport(displayThreadItems(s), s.scrollPage).content;
}

function displayThreadItems(s: AppState): StreamItem[] {
  if (s.phase === "review" && s.pending) {
    return [...s.stream, { kind: "user", text: s.pending.transcript }];
  }
  return s.stream;
}

function statusText(s: AppState): string {
  const base = barText(s);
  const items = displayThreadItems(s);
  if (s.phase !== "idle" || items.length === 0) return base;

  const viewport = currentThreadViewport(items, s.scrollPage);
  return viewport.total > 1 ? `${base} · ${viewport.index + 1}/${viewport.total}` : base;
}
