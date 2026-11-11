import { HINTS, defaultOptionIndex, offlineNotice, type AppState, type StreamItem } from "../state/store";
import { promptResponse, sessionsNew, sessionsSwitch, textMsg, sessionsList } from "../protocol";
import { isOwnSession, isKnownOwnSession, listableSessions, pickResumeSession, sessionForListIndex } from "../ui/session-list";
import { nextThreadViewportCursor, previousThreadViewportIndex } from "../ui/stream";

export type Gesture = "click" | "doubleClick" | "longPress" | "scrollUp" | "scrollDown";

export type Effect =
  | { kind: "send"; frame: string }
  | { kind: "startMic" }
  | { kind: "stopMic" }
  | { kind: "exit" };

export interface DispatchResult { state: AppState; effects: Effect[]; }

export function generateTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const enterSession = (
  s: AppState,
  active: string | null,
  opts?: { newSession?: boolean },
): AppState => ({
  ...s, screen: "session", phase: "idle", stream: [], pending: null, turn: "idle",
  scrollPage: null,
  history: { loadingFor: active, failedFor: null, refresh: false },
  sessions: { ...s.sessions, active },
  readonlyNoHistory: false,
  expectingNewSession: opts?.newSession ?? false,
  unconfirmedOwnId: null,
});

/**
 * Boot landing: the conversation screen of the session to resume — the
 * bridge's active id if it is own, else the persisted one, else the most
 * recent own session, else a brand-new session. Runs once per connection on
 * the first `sessions` frame; the caller must not re-fire it on retry-loop
 * frames (a second sessions.new would orphan the first).
 */
export function resumeOnBoot(s: AppState, persisted: string | null | undefined): DispatchResult {
  const id = pickResumeSession(s.sessions.items, s.sessions.active, persisted ?? null);
  if (!id) {
    return {
      state: enterSession(s, null, { newSession: true }),
      effects: [{ kind: "send", frame: sessionsNew() }],
    };
  }
  // The reconnect re-pin (sessions.switch sent on hello.ok) already asked for
  // this session's history — don't ask twice.
  if (s.sessions.active === id && s.history.loadingFor === id) {
    return { state: enterSession(s, id), effects: [] };
  }
  return { state: enterSession(s, id), effects: [{ kind: "send", frame: sessionsSwitch(id) }] };
}

/**
 * A resume that the bridge refused (error frame) or that never answered
 * (client-side timeout) must not leave the bar saying "loading session..."
 * forever. First failure: fall back to the most recent other own session.
 * A second, DIFFERENT failure means the list itself is untrustworthy — go
 * straight to a fresh session instead of hopping between dead ids (a fresh
 * session that also fails lands in a terminal, notice-only state: its
 * loadingFor is null, so nothing retries).
 */
export function recoverUnavailableSession(
  s: AppState,
  failedId: string,
  alreadyFailed?: string | null,
): DispatchResult {
  const priorFailure = alreadyFailed && alreadyFailed !== failedId ? alreadyFailed : null;
  const fallback =
    priorFailure
      ? null
      : listableSessions(s.sessions.items)
        .map((i) => i.id)
        .find((id) => id !== failedId && id !== s.sessions.active)
      ?? null;
  return {
    state: {
      ...enterSession(s, fallback, { newSession: !fallback }),
      history: { loadingFor: fallback, failedFor: failedId, refresh: false },
      notice: HINTS.noticeSessionOpenFailed,
    },
    effects: [
      fallback
        ? { kind: "send" as const, frame: sessionsSwitch(fallback) }
        : { kind: "send" as const, frame: sessionsNew() },
    ],
  };
}

/**
 * The session ids of the rows currently DISPLAYED, captured at render time.
 * `ids[i]` is the session for row `i`, or null for the ＋New row.
 *
 * A tap arrives as an index into what is on screen, and the list re-sorts by
 * recency whenever a `sessions` frame lands — so the index has to be resolved
 * against the snapshot the wearer was looking at, not against live state.
 */
export interface ListSnapshot {
  ids: (string | null)[];
}

/** ＋New highlighted + long-press/double-tap: exactly one sessions.new (A3). */
const startNewSession = (s: AppState): DispatchResult => ({
  state: enterSession(s, null, { newSession: true }),
  effects: [{ kind: "send", frame: sessionsNew() }],
});

/**
 * A1: a plain tap on ＋New (or with no row info) opens the CURRENT own
 * session — a switch, never a new session. "Current" is the active session
 * when it is ours (or the one we just created), else the newest own session.
 * With no own session at all there is nothing to switch to: show the hint
 * (A5) and send nothing.
 */
function openCurrent(s: AppState): DispatchResult {
  const active = s.sessions.active;
  const currentIsOurs = Boolean(
    active && (isKnownOwnSession(s.sessions.items, active) || active === s.unconfirmedOwnId),
  );
  const id = currentIsOurs ? active : listableSessions(s.sessions.items)[0]?.id ?? null;
  if (!id) {
    return { state: { ...s, notice: HINTS.hintNewSession }, effects: [] };
  }
  return { state: enterSession(s, id), effects: [{ kind: "send", frame: sessionsSwitch(id) }] };
}

export function dispatch(
  s: AppState,
  g: Gesture,
  index?: number,
  shown?: ListSnapshot,
  idGenerator: () => string = generateTurnId,
): DispatchResult {
  if (s.notice) s = { ...s, notice: null };
  if (s.screen === "list") {
    // Exit must work even while sessions are still loading (A4). ＋New
    // highlighted (row 0) with a loaded list starts a session instead (A3);
    // creating one before the list hydrates would race the boot resume.
    if (g === "doubleClick") {
      if (s.sessionsLoaded && index === 0) return startNewSession(s);
      return { state: s, effects: [{ kind: "exit" }] };
    }
    if (!s.sessionsLoaded) return { state: s, effects: [] };
    if (g === "longPress") {
      // A3 requires ＋New highlighted; a stray long-press with no row info
      // must not mint sessions (the duplicate-session bug class).
      if (index === 0) return startNewSession(s);
      return { state: s, effects: [] };
    }
    if (g === "click") {
      const i = index ?? 0; // no row info ≡ ＋New (proto3 omits index 0)
      if (i < 0) return { state: s, effects: [] }; // ambiguous row name: ignored
      if (i === 0) {
        return openCurrent(s);
      }
      // Falls back to live state when no snapshot is supplied, so existing
      // callers keep their current behaviour.
      const id = shown ? shown.ids[i] ?? null : sessionForListIndex(s.sessions.items, i)?.id ?? null;
      if (!id) return { state: s, effects: [] };
      const item = s.sessions.items.find((x) => x.id === id);
      // Defense-in-depth for stale on-screen lists: a read-only id that can no
      // longer appear in a rendered row still opens the local read-only view
      // instead of a switch. The own-session guard below is the real gate.
      if (item?.read_only) {
        return {
          state: {
            ...enterSession(s, id),
            history: { loadingFor: null, failedFor: null, refresh: false },
            stream: s.sessions.active === id ? s.stream : [],
            readonlyNoHistory: true,
          },
          effects: [],
        };
      }
      // Immediately before switching, the session must still exist and be OURS
      // in the live list (or be the just-created session): the displayed row
      // can be stale — deleted or re-flagged foreign since it was drawn — and
      // switching into it would hijack the conversation.
      if (!item || !isOwnSession(item)) {
        if (id !== s.unconfirmedOwnId) return { state: s, effects: [] };
      }
      return { state: enterSession(s, id), effects: [{ kind: "send", frame: sessionsSwitch(id) }] };
    }
    return { state: s, effects: [] };
  }
  // screen === "session"
  const activeSessionItem = s.sessions.items.find((x) => x.id === s.sessions.active);
  // Speakable = own (!foreign && !read_only). A just-created session is not in
  // items yet — its bridge-assigned id is tracked as unconfirmedOwnId.
  const canSpeak = activeSessionItem
    ? isOwnSession(activeSessionItem)
    : s.sessions.active == null || s.sessions.active === s.unconfirmedOwnId;

  // Prompt gate (§C): while a prompt is queued and the phase lets the wearer
  // answer, gestures drive the prompt panel instead of the conversation.
  // Outside idle/review gestures keep their meaning and the panel stays (A8).
  if (s.prompts.length > 0 && (s.phase === "idle" || s.phase === "review")) {
    const p = s.prompts[0];
    const n = p.options.length;
    if (g === "scrollUp" || g === "scrollDown") {
      const next = Math.min(Math.max(s.promptHighlight + (g === "scrollUp" ? -1 : 1), 0), n - 1);
      return next === s.promptHighlight
        ? { state: s, effects: [] }
        : { state: { ...s, promptHighlight: next }, effects: [] };
    }
    if (g === "click" || g === "doubleClick") {
      // A tap confirms the highlighted option; a double-tap the default.
      // The answer is always an offered id (A12) and removes the prompt
      // locally (§C rule 8), resetting the highlight to the next head's
      // default.
      const idx = g === "doubleClick"
        ? defaultOptionIndex(p)
        : Math.min(Math.max(s.promptHighlight, 0), n - 1);
      const prompts = s.prompts.slice(1);
      return {
        state: {
          ...s,
          prompts,
          promptHighlight: prompts.length ? defaultOptionIndex(prompts[0]) : 0,
        },
        effects: [{ kind: "send", frame: promptResponse(p.id, p.options[idx].id) }],
      };
    }
    // long-press is ignored while the gate is active.
    return { state: s, effects: [] };
  }

  if (s.phase === "idle") {
    if (g === "click") {
      // No socket, no voice turn: starting the mic would record a message that
      // cannot be delivered. Say why instead — and only promise a reconnect
      // when the socket is actually retrying.
      if (s.conn !== "connected") {
        return { state: { ...s, notice: offlineNotice(s.conn) }, effects: [] };
      }
      if (!canSpeak) return { state: s, effects: [] };
      const lastItem = s.stream[s.stream.length - 1];
      if (lastItem && lastItem.kind === "user" && lastItem.delivery === "uncertain") {
        const updatedStream: StreamItem[] = [
          ...s.stream.slice(0, -1),
          { ...lastItem, delivery: "pending" },
        ];
        return {
          state: { ...s, stream: updatedStream, turn: "thinking", scrollPage: null },
          effects: [{ kind: "send", frame: textMsg(lastItem.text, lastItem.id) }],
        };
      }
      return { state: { ...s, phase: "recording", scrollPage: null }, effects: [{ kind: "startMic" }] };
    }
    if (g === "doubleClick") return { state: { ...s, screen: "list", phase: "idle", pending: null }, effects: [{ kind: "send", frame: sessionsList() }] };
    if (g === "scrollUp") {
      const prev = previousThreadViewportIndex(s.stream, s.scrollPage);
      return prev === s.scrollPage ? { state: s, effects: [] } : { state: { ...s, scrollPage: prev }, effects: [] };
    }
    if (g === "scrollDown") {
      const next = nextThreadViewportCursor(s.stream, s.scrollPage);
      return next === s.scrollPage ? { state: s, effects: [] } : { state: { ...s, scrollPage: next }, effects: [] };
    }
    return { state: s, effects: [] };
  }
  if (s.phase === "recording") {
    if (g === "click") return { state: { ...s, phase: "transcribing" }, effects: [{ kind: "stopMic" }] };
    if (g === "doubleClick") return { state: { ...s, phase: "idle" }, effects: [{ kind: "stopMic" }] };
    return { state: s, effects: [] };
  }
  if (s.phase === "transcribing") {
    if (g === "doubleClick") return { state: { ...s, phase: "idle" }, effects: [] };
    return { state: s, effects: [] };
  }
  if (s.phase === "review") {
    if (g === "click" && s.pending) {
      // Sending into a dead socket would silently lose the transcript: keep it
      // pending and explain, so the wearer can send once reconnected.
      if (s.conn !== "connected") {
        return { state: { ...s, notice: offlineNotice(s.conn) }, effects: [] };
      }
      const text = s.pending.transcript;
      const id = idGenerator();
      return {
        state: {
          ...s,
          stream: [...s.stream, { kind: "user", text, id, delivery: "pending" }],
          pending: null,
          phase: "idle",
          turn: "thinking",
          scrollPage: null,
        },
        effects: [{ kind: "send", frame: textMsg(text, id) }],
      };
    }
    if (g === "scrollDown") return { state: { ...s, pending: null, phase: "idle" }, effects: [] };
    // Discard, stay in the conversation — the list stays behind a second
    // double-press from idle. Exiting from review lost the thread's context.
    if (g === "doubleClick") return { state: { ...s, pending: null, phase: "idle" }, effects: [] };
    return { state: s, effects: [] };
  }
  return { state: s, effects: [] };
}
