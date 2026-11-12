import type { HistoryItem, PromptOption, ServerMsg, SessionItem } from "../protocol";
import { isKnownForeignSession, truncateTitle } from "../ui/session-list";

/**
 * Every status/notice string the glasses render, in one place. Firmware-safe
 * glyphs only — ● ◌ · … ＋ ↓ have font metrics, emoji do NOT (they are dropped
 * silently; tests/glyphs.test.ts pins this).
 */
export const HINTS = {
  ready: "ready",
  thinking: "thinking…",
  working: "working…",
  // NOT an emoji. The firmware font has none and drops them SILENTLY, so a mic
  // emoji here rendered as a stray gap. `●` is in the font.
  recording: "● recording · tap to stop",
  transcribing: "transcribing…",
  review: "tap = send · swipe↓ = discard",
  historyLoading: "loading session...",
  historyUnavailable: "history unavailable",
  readonlyBanner: "History not shown (Telegram-owned session, read-only)",
  tapToSpeak: "tap to speak",
  noticeDeliveryUncertain: "not delivered · tap to resend",
  noticeDeliveryOffline: "not delivered · resend when online",
  noticeTranscriptEmpty: "didn't catch that · tap to retry",
  noticeOffline: "offline · reconnecting…",
  noticeOfflineIdle: "offline · check connection",
  noticeSessionOpenFailed: "couldn't open that session",
  // A5: a tap on ＋New with nothing to open — the only way to a first session
  // is the ＋New row highlighted + long-press (or double-tap).
  hintNewSession: "long-press ＋New to start",
} as const;

export type Screen = "list" | "session";
export type Phase = "idle" | "recording" | "transcribing" | "review";
export type Turn = "idle" | "thinking" | "working";

/** A pending `prompt.request` (§C). The queue is oldest-first; the head is the
 *  active prompt, and `promptHighlight` is the highlighted option INDEX of the
 *  head prompt. */
export interface Prompt {
  id: string;
  kind: string;
  title: string;
  command: string;
  description: string;
  options: PromptOption[];
  timeout_s: number;
  timeout_choice: string | null;
}

/** Index of the default option — the initial and reset highlight (A11). */
export function defaultOptionIndex(p: Prompt): number {
  return Math.max(0, p.options.findIndex((o) => o.default === true));
}

/** Highlight resets to the default whenever the head prompt changes (§C rule 8). */
function withPromptQueue(s: AppState, prompts: Prompt[]): AppState {
  const prevHead = s.prompts[0]?.id;
  const head = prompts[0]?.id;
  return {
    ...s,
    prompts,
    promptHighlight: head !== prevHead && prompts.length ? defaultOptionIndex(prompts[0]) : s.promptHighlight,
  };
}

export type StreamItem = HistoryItem;

export interface HistoryState {
  loadingFor: string | null;
  failedFor: string | null;
  /** True when the load was triggered without changing the active session
   *  (reconnect re-pin): a history reply must preserve in-progress work. */
  refresh: boolean;
}

export interface AppState {
  screen: Screen;
  phase: Phase;
  conn: string;
  sessions: { items: SessionItem[]; active: string | null };
  sessionsLoaded: boolean;
  /** Bridge capability snapshot from the last hello.ok (profile, ASR, timeout). */
  caps: Record<string, unknown>;
  history: HistoryState;
  stream: StreamItem[];
  pending: { transcript: string } | null;
  turn: Turn;
  scrollPage: number | null; // null = follow latest viewport; number = measured viewport index (held)
  notice: string | null;
  /** Pending prompts, oldest first; prompts[0] is the active one (§C rule 8). */
  prompts: Prompt[];
  /** Highlighted option index within prompts[0]. */
  promptHighlight: number;
  readonlyNoHistory?: boolean;
  /** We sent sessions.new and haven't adopted the bridge-assigned id yet. */
  expectingNewSession: boolean;
  /** The bridge-assigned id of OUR just-created session, not yet listed own. */
  unconfirmedOwnId: string | null;
}

export function initialState(): AppState {
  return {
    screen: "list",
    phase: "idle",
    conn: "connecting",
    sessions: { items: [], active: null },
    sessionsLoaded: false,
    caps: {},
    history: { loadingFor: null, failedFor: null, refresh: false },
    stream: [],
    pending: null,
    turn: "idle",
    scrollPage: null,
    notice: null,
    prompts: [],
    promptHighlight: 0,
    readonlyNoHistory: false,
    expectingNewSession: false,
    unconfirmedOwnId: null,
  };
}

// Assistant output before the first user item is the session banner (model,
// cwd, …); after the user has spoken it is normal assistant text. Either kind
// extends its own trailing segment so streamed deltas coalesce.
function appendStream(stream: StreamItem[], delta: string): StreamItem[] {
  const kind: "assistant" | "banner" =
    stream.some((it) => it.kind === "user") ? "assistant" : "banner";
  const last = stream[stream.length - 1];
  if (last && last.kind === kind) {
    return [...stream.slice(0, -1), { kind, text: last.text + delta }];
  }
  return [...stream, { kind, text: delta }];
}

function replaceAssistantSnapshot(stream: StreamItem[], text: string): StreamItem[] {
  const kind: "assistant" | "banner" =
    stream.some((it) => it.kind === "user") ? "assistant" : "banner";
  const last = stream[stream.length - 1];
  if (last && last.kind === kind) {
    return [...stream.slice(0, -1), { kind, text }];
  }
  return [...stream, { kind, text }];
}

function patchTool(stream: StreamItem[], name: string, ok: boolean): StreamItem[] {
  for (let i = stream.length - 1; i >= 0; i--) {
    const it = stream[i];
    if (it.kind === "tool" && it.running && it.name === name) {
      const patched: StreamItem = { kind: "tool", name: it.name, label: it.label, running: false, ok };
      return [...stream.slice(0, i), patched, ...stream.slice(i + 1)];
    }
  }
  return stream;
}

// A reconnect re-pin re-delivers history for the session we are already
// reading. The server copy is authoritative — except for local turns it never
// received (delivery "uncertain"): those are still resendable work, so they
// survive the refresh (matched by text).
function mergeRefreshedStream(local: StreamItem[], server: StreamItem[]): StreamItem[] {
  const localUncertain = local.filter(
    (it): it is StreamItem & { kind: "user" } => it.kind === "user" && it.delivery === "uncertain",
  );
  if (localUncertain.length === 0) return server;
  const serverUserTexts = new Set(
    server.filter((it): it is StreamItem & { kind: "user" } => it.kind === "user").map((it) => it.text),
  );
  const missing = localUncertain.filter((it) => !serverUserTexts.has(it.text));
  return missing.length ? [...server, ...missing] : server;
}

const STATUS_BAR_WIDTH_PX = 576;
const STATUS_BAR_MAX_CHARS = 64;

function truncateNotice(text: string): string {
  return truncateTitle(text, STATUS_BAR_WIDTH_PX, STATUS_BAR_MAX_CHARS);
}

export function reduce(s: AppState, m: ServerMsg): AppState {
  switch (m.t) {
    case "hello.ok": {
      // A fresh hello.ok is a (re)connect: queued prompts died with the old
      // bridge process (§C rule 8), so they clear on every path below.
      const caps = m.caps && typeof m.caps === "object" ? m.caps : {};
      const reset = { ...s, caps, prompts: [] as Prompt[], promptHighlight: 0 };
      // A reconnect must not move the wearer out of their conversation: the
      // local active id wins; the connection layer re-pins it bridge-side.
      if (s.sessions.active) return reset;
      if (!m.active || isKnownForeignSession(s.sessions.items, m.active)) return reset;
      return { ...reset, sessions: { ...s.sessions, active: m.active } };
    }
    case "sessions": {
      const keepActive =
        isHistoryLoading(s)
        || s.readonlyNoHistory
        || isKnownForeignSession(m.items, m.active)
        // On the session screen the wearer is mid-conversation; a frame echo
        // (e.g. active "" right after a bridge restart) must not clear it.
        || (s.screen === "session" && Boolean(s.sessions.active));
      const unconfirmedListed = Boolean(s.unconfirmedOwnId)
        && m.items.some((i) => i.id === s.unconfirmedOwnId);
      return {
        ...s,
        sessionsLoaded: true,
        unconfirmedOwnId: unconfirmedListed ? null : s.unconfirmedOwnId,
        sessions: { items: m.items, active: keepActive ? s.sessions.active : m.active },
      };
    }
    case "active": {
      // A Telegram session can be active on the bridge side; adopting its id
      // here would steal the G2 conversation out from under the wearer —
      // UNLESS we are the ones waiting on a switch (V2): the answer to a tap
      // on a resumable foreign row may carry that foreign id (direct repoint)
      // or the minted handoff child (an unknown id), and both must land.
      if (s.history.loadingFor === null && isKnownForeignSession(s.sessions.items, m.id)) return s;
      const unknown = !s.sessions.items.some((i) => i.id === m.id);
      // An unknown id is OURS when we created it (sessions.new) or when it
      // answers a pending switch (the minted cross-surface handoff child).
      const claimOurs = unknown && (s.expectingNewSession || s.history.loadingFor !== null);
      return {
        ...s,
        sessions: { ...s.sessions, active: m.id },
        history: { loadingFor: m.id, failedFor: null, refresh: m.id === s.sessions.active },
        readonlyNoHistory: false,
        expectingNewSession: claimOurs ? false : s.expectingNewSession,
        unconfirmedOwnId: claimOurs ? m.id : s.unconfirmedOwnId,
      };
    }
    case "history": {
      if (m.id !== s.sessions.active && m.id !== s.history.loadingFor) return s;
      // A refresh re-delivers the session we are already reading (reconnect
      // re-pin): keep the review draft and reading position, keep local turns
      // the server never received. A cold load (empty stream) resets as before.
      const refresh = s.history.refresh && s.stream.length > 0;
      // A refused fetch (ok:false — the bridge answering a re-pin switch with
      // an empty history and NO active frame, so the refresh flag never
      // armed) must not wipe the conversation it failed to refresh. Cold
      // loads always start with an empty local stream, so this only keeps
      // work that is already on screen.
      const refused = m.ok === false && s.stream.length > 0;
      const keepLocal = refresh || refused;
      const keepReview = keepLocal && s.phase === "review";
      return {
        ...s,
        sessions: { ...s.sessions, active: m.id },
        history: { loadingFor: null, failedFor: m.ok === false ? m.id : null, refresh: false },
        readonlyNoHistory: false,
        stream: refresh ? mergeRefreshedStream(s.stream, m.items) : refused ? s.stream : m.items,
        pending: keepReview ? s.pending : null,
        phase: keepReview ? "review" : "idle",
        turn: "idle",
        scrollPage: keepLocal ? s.scrollPage : null,
      };
    }
    case "error":
      // Errors arrive while the socket itself may be fine (e.g. a rejected
      // turn); conn belongs to the ws-client status, so notice-only.
      return {
        ...s,
        turn: "idle",
        notice: truncateNotice(`error: ${m.msg}`),
        history: s.history.loadingFor
          ? { loadingFor: null, failedFor: s.history.loadingFor, refresh: s.history.refresh }
          : s.history,
      };
    case "assistant.delta":
      return { ...s, history: { loadingFor: null, failedFor: null, refresh: false }, stream: appendStream(s.stream, m.text), scrollPage: null };
    case "assistant":
      return { ...s, history: { loadingFor: null, failedFor: null, refresh: false }, stream: replaceAssistantSnapshot(s.stream, m.text), scrollPage: null };
    case "tool.start":
      return {
        ...s,
        history: { loadingFor: null, failedFor: null, refresh: false },
        stream: [...s.stream, { kind: "tool", name: m.name, label: m.label, running: true }],
        turn: "working",
        scrollPage: null,
      };
    case "tool.end":
      return { ...s, stream: patchTool(s.stream, m.name, m.ok) };
    case "turn.done":
      return { ...s, turn: "idle" };
    case "prompt.request": {
      if (s.prompts.some((p) => p.id === m.id)) return s; // dedupe by id
      const prompt: Prompt = {
        id: m.id,
        kind: m.kind,
        title: m.title,
        command: m.command,
        description: m.description,
        options: m.options,
        timeout_s: m.timeout_s,
        timeout_choice: m.timeout_choice,
      };
      // A prompt switches to the session screen without changing the active
      // session or the phase (§C rule 8, A6).
      return { ...withPromptQueue(s, [...s.prompts, prompt]), screen: "session" };
    }
    case "prompt.resolved": {
      if (!s.prompts.some((p) => p.id === m.id)) return s; // no-op when absent
      return withPromptQueue(s, s.prompts.filter((p) => p.id !== m.id));
    }
    case "notice":
      return { ...s, notice: m.text };
    case "ack":
      if (m.ok) {
        return {
          ...s,
          stream: s.stream.map((item) =>
            item.kind === "user" && item.id === m.id
              ? { ...item, delivery: "delivered" }
              : item
          ),
        };
      }
      return markDeliveryUncertain(s, m.id);
    case "transcript":
      if (s.phase !== "transcribing") return s;
      return m.text.trim()
        ? { ...s, pending: { transcript: m.text }, phase: "review", scrollPage: null }
        : { ...s, phase: "idle", notice: HINTS.noticeTranscriptEmpty };
    default:
      return s;
  }
}

export function barText(s: AppState): string {
  switch (s.phase) {
    case "recording": return HINTS.recording;
    case "transcribing": return HINTS.transcribing;
    case "review": return HINTS.review;
    case "idle":
    default: {
      if (s.notice) return s.notice;
      // An uncertain last turn is resendable work: the hint belongs in the bar
      // for as long as it stands — not only while its notice is alive.
      const last = s.stream[s.stream.length - 1];
      if (last && last.kind === "user" && last.delivery === "uncertain") {
        return deliveryHint(s.conn);
      }
      if (s.readonlyNoHistory) return HINTS.readonlyBanner;
      if (isHistoryLoading(s)) return HINTS.historyLoading;
      if (isHistoryUnavailable(s)) return HINTS.historyUnavailable;
      if (s.turn === "working") {
        for (let i = s.stream.length - 1; i >= 0; i--) {
          const it = s.stream[i];
          if (it.kind === "tool" && it.running) return `${HINTS.working} (${it.name})`;
        }
        return HINTS.working;
      }
      return s.turn === "thinking" ? HINTS.thinking : HINTS.ready;
    }
  }
}

/** The resend hint picks its wording from the socket: promising "tap to
 *  resend" while offline would just bounce into an offline notice. */
export function deliveryHint(conn: string): string {
  return conn === "connected" ? HINTS.noticeDeliveryUncertain : HINTS.noticeDeliveryOffline;
}

/** Auto-reconnecting sockets promise a reconnect; dead ones (manual
 *  disconnect, rejected token) must ask for a check instead. */
export function offlineNotice(conn: string): string {
  const autoReconnecting =
    conn === "reconnecting"
    || conn === "websocket error; reconnecting"
    || conn.startsWith("connecting");
  return autoReconnecting ? HINTS.noticeOffline : HINTS.noticeOfflineIdle;
}

/** Pure half of the ws-client onDisconnected callback: stop capture phases and
 *  mark every in-flight turn uncertain — nothing can be delivered now. */
export function applyDisconnected(s: AppState): AppState {
  const phase: Phase = s.phase === "recording" || s.phase === "transcribing" ? "idle" : s.phase;
  // Prompts die with the socket (§C rule 8): the bridge resets its queue on
  // reconnect, and a stale panel would answer a dead question.
  return markDeliveryUncertain({ ...s, phase, prompts: [], promptHighlight: 0 });
}

export function connDot(conn: string): string {
  return conn === "connected" ? "●" : "◌";
}

export function isHistoryLoading(s: AppState): boolean {
  return Boolean(s.sessions.active && s.history.loadingFor === s.sessions.active);
}

export function isHistoryUnavailable(s: AppState): boolean {
  return Boolean(s.sessions.active && s.history.failedFor === s.sessions.active);
}

/** A reconnect re-pin's history refresh with work still on screen: F7
 *  recovery (which enters a session cold) must not wipe it. The empty-stream
 *  check keeps fallback loads — whose confirming active frame sets the flag
 *  over a stream enterSession just wiped — fully recoverable. */
export function isRefreshWithWork(s: AppState): boolean {
  return s.history.refresh && s.stream.length > 0;
}

export function markDeliveryUncertain(s: AppState, id?: string): AppState {
  let changed = false;
  const stream = s.stream.map((item) => {
    if (item.kind === "user" && item.delivery === "pending" && (!id || item.id === id)) {
      changed = true;
      return { ...item, delivery: "uncertain" as const };
    }
    return item;
  });
  if (!changed) return s;
  return {
    ...s,
    stream,
    turn: "idle",
    notice: deliveryHint(s.conn),
  };
}
