import { waitForEvenAppBridge, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import "./style.css";
import { loadBridgeDefaults } from "./config";
import { BridgeClient } from "./net/ws-client";
import { initialState, applyDisconnected, markDeliveryUncertain, type AppState } from "./state/store";
import { createHistoryWatch } from "./state/history-watch";
import { applyServerMessage, type ConnectionFlags } from "./state/connection";
import { sessionsList } from "./protocol";
import { createLoadingStartup, createSetupStartup, showLoadingPage } from "./ui/render";
import { loadingText } from "./ui/views";
import { createPageRenderer, pageRendererDeps } from "./ui/render-queue";
import { renderPhoneSetup } from "./ui/phone";
import { routeEvent } from "./input/router";
import { dispatch, type Gesture, type Effect } from "./input/dispatch";
import { createTapArbiter } from "./input/tap-arbiter";
import { createListGestures } from "./input/list-gestures";
import { isKnownOwnSession } from "./ui/session-list";
import { createCapture } from "./audio/capture";
import {
  isConfiguredProfile,
  loadConnectionProfile,
  saveConnectionProfile,
  updateActiveSession,
  validateConnectionProfile,
  type ConnectionProfile,
} from "./storage/persist";

const fireAndForget = (p: Promise<unknown>): void => { void p.catch(() => {}); };

/**
 * How long after a scroll the list is treated as "being read", and rebuilds are
 * held back. Long enough to page through a full list without being yanked to
 * the top by an incoming `sessions` frame.
 */
const LIST_SCROLL_GRACE_MS = 8_000;

/** A history load that has not answered by then is treated as refused (F7). */
const HISTORY_TIMEOUT_MS = 6_000;

/** §C gate: a lone tap waits this long for a DOUBLE_CLICK before confirming. */
const TAP_ARBITER_MS = 400;

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Missing #app root");

  const bridge = await waitForEvenAppBridge();
  const defaults = loadBridgeDefaults();
  let profile = await loadConnectionProfile(bridge);
  let state: AppState = initialState();
  let phoneErrors: string[] = [];
  let glassesView: "setup" | "list" = profileIsReady(profile) ? "list" : "setup";
  /** When the wearer last scrolled the list — a rebuild while reading is hostile. */
  let lastListScrollAt = 0;
  /**
   * Boot resume runs ONCE per app launch (reset only by saveAndConnect, never
   * on hello.ok): a reconnect re-pins instead, so in-progress work survives.
   */
  let flags: ConnectionFlags = { helloOk: false, bootResumeDone: false };
  let sessionsRetryTimer: ReturnType<typeof setInterval> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearNoticeTimer = (): void => {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
  };

  const armNoticeTimer = (): void => {
    clearNoticeTimer();
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      if (state.notice) {
        state = { ...state, notice: null };
        scheduleRender(state);
      }
    }, 8000);
  };

  const armDeliveryTimer = (id: string): void => {
    const existing = deliveryTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      deliveryTimers.delete(id);
      const prev = state;
      state = markDeliveryUncertain(state, id);
      if (state !== prev) {
        scheduleRender(state);
        armNoticeTimer();
      }
    }, 8000);
    deliveryTimers.set(id, timer);
  };

  const clearDeliveryTimer = (id: string): void => {
    const timer = deliveryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      deliveryTimers.delete(id);
    }
  };

  const clearAllDeliveryTimers = (): void => {
    for (const timer of deliveryTimers.values()) {
      clearTimeout(timer);
    }
    deliveryTimers.clear();
  };

  if (glassesView === "list") {
    await createLoadingStartup(bridge);
  } else {
    state = { ...state, conn: "not configured" };
    await createSetupStartup(bridge);
  }

  // The ONE path that writes pages to the glasses; page-kind transitions ride
  // inside the serialized queue so a resume can never race a list build (F4).
  const pages = createPageRenderer(pageRendererDeps(bridge, () =>
    Date.now() - lastListScrollAt < LIST_SCROLL_GRACE_MS,
  ));
  const scheduleRender = (s: AppState): void => {
    if (glassesView !== "setup") pages.render(s);
  };

  /**
   * A history load that never resolves (bridge wedged on the switch) must not
   * leave the bar at "loading session..." forever — same fallback as an
   * explicit error frame, on a client-side timer (F7, N1a/N2).
   */
  const historyWatch = createHistoryWatch(HISTORY_TIMEOUT_MS, {
    getState: () => state,
    onTransition: (s, effects) => {
      state = s;
      for (const e of effects) runEffect(e);
      scheduleRender(state);
      armNoticeTimer();
    },
  });

  const renderPhone = (): void => {
    renderPhoneSetup(root, {
      profile,
      defaults,
      status: state.conn,
      errors: phoneErrors,
    }, {
      onSaveConnect: (url, token) => {
        fireAndForget(saveAndConnect(url, token));
      },
      onDisconnect: () => {
        client.disconnect();
      },
    });
  };

  const setStatus = (conn: string): void => {
    state = { ...state, conn };
    scheduleRender(state);
    renderPhone();
  };

  const persistActiveSession = (activeSession: string | null): void => {
    if (!profile) return;
    fireAndForget(updateActiveSession(bridge, profile, activeSession).then((next) => {
      profile = next;
      renderPhone();
    }));
  };

  const startSessionsRetry = (): void => {
    if (sessionsRetryTimer) return;
    sessionsRetryTimer = setInterval(() => {
      if (flags.helloOk && !state.sessionsLoaded) client.send(sessionsList());
    }, 2000);
  };

  const stopSessionsRetry = (): void => {
    clearInterval(sessionsRetryTimer);
    sessionsRetryTimer = undefined;
  };

  /** §C gate: gestures answer the head prompt only while it can be answered. */
  const promptGateActive = (): boolean =>
    state.screen === "session"
    && state.prompts.length > 0
    && (state.phase === "idle" || state.phase === "review");

  // While the gate is active a lone tap confirms the highlighted option after
  // the arbiter window; a double-tap (or CLICK+DOUBLE_CLICK) sends the default
  // exactly once (A7). The callbacks re-check the gate at fire time, so a
  // gesture held past a prompt.resolved or a phase change lands nowhere.
  const tapArbiter = createTapArbiter({
    windowMs: TAP_ARBITER_MS,
    onTap: () => {
      if (promptGateActive()) applyGesture("click");
    },
    onDoubleTap: () => {
      if (promptGateActive()) applyGesture("doubleClick");
    },
  });

  // List-screen tap arbitration (held ＋New clicks, combined CLICK +
  // DOUBLE_CLICK sequences) lives in input/list-gestures; the prompt-gate
  // arbiter above stays here.
  const listGestures = createListGestures({
    windowMs: TAP_ARBITER_MS,
    promptGateActive,
    promptTap: tapArbiter,
    onListScreen: () => state.screen === "list",
    rows: () => pages.snapshot().rows,
    apply: applyGesture,
  });

  const client = new BridgeClient({
    onMessage: (m) => {
      const prevNotice = state.notice;
      const prevLoadingFor = state.history.loadingFor;
      const prevPromptHead = state.prompts[0]?.id;
      // Frame sequencing (re-pin, boot resume, recovery, persist gating) lives
      // in the pure connection layer; main only wires side effects. The render
      // is scheduled AFTER the resume decision so the first sessions frame
      // can't draw a list the resume is about to replace (F4).
      const r = applyServerMessage(state, m, flags, profile?.activeSession ?? null);
      state = r.state;
      flags = r.flags;
      // A held tap must never answer a prompt that changed underneath it
      // (answered, resolved, cleared by hello.ok) — only the prompt it saw.
      if (state.prompts[0]?.id !== prevPromptHead) {
        tapArbiter.cancel();
        // A prompt landing mid-window also ends any held ＋New click: the
        // next gestures belong to the prompt gate, not the list.
        listGestures.cancel();
      }
      // Any freshly-set notice (error frame, empty transcript, …) auto-expires.
      if (state.notice && state.notice !== prevNotice) armNoticeTimer();
      for (const e of r.effects) runEffect(e);
      if (r.persist) persistActiveSession(r.persist);
      if (m.t === "hello.ok") startSessionsRetry();
      if (m.t === "sessions") stopSessionsRetry();
      if (m.t === "ack") clearDeliveryTimer(m.id);
      scheduleRender(state);
      historyWatch.update(prevLoadingFor, state.history.loadingFor);
    },
    onStatus: setStatus,
    onDisconnected: () => {
      clearAllDeliveryTimers();
      // Prompts die with the socket (§C rule 8); a held tap must die with them.
      tapArbiter.cancel();
      listGestures.cancel();
      // Recording into a dropped socket would produce a turn that can never be
      // delivered — stop the mic and fall back to idle.
      if (state.phase === "recording") {
        capture.stop().catch(() => {});
      }
      const prev = state;
      state = applyDisconnected(state);
      if (state !== prev) {
        scheduleRender(state);
        armNoticeTimer();
      }
    },
  });

  async function saveAndConnect(url: string, token: string): Promise<void> {
    const candidate: ConnectionProfile = {
      url,
      token,
      activeSession: profile?.activeSession,
      updatedAt: Date.now(),
    };
    const validation = validateConnectionProfile(candidate);
    if (!validation.valid) {
      phoneErrors = validation.errors;
      setStatus("not configured");
      return;
    }

    phoneErrors = [];
    profile = await saveConnectionProfile(bridge, candidate);
    if (glassesView === "setup") {
      glassesView = "list";
      await showLoadingPage(bridge, loadingText(state));
    }
    // A user-initiated connect is a fresh launch for the boot resume (F1).
    flags = { helloOk: false, bootResumeDone: false };
    client.connect(profile);
    renderPhone();
  }

  renderPhone();
  if (profileIsReady(profile)) {
    client.connect(profile);
  }

  const capture = createCapture(bridge, client, (err) => {
    console.error("[glasses] capture error", err);
    if (state.phase === "recording") {
      state = { ...state, phase: "idle" };
      scheduleRender(state);
    }
  });

  function runEffect(e: Effect): void {
    if (e.kind === "send") {
      client.send(e.frame);
      try {
        const parsed = JSON.parse(e.frame);
        if (parsed.t === "text" && typeof parsed.id === "string") {
          armDeliveryTimer(parsed.id);
        }
      } catch {}
    }
    else if (e.kind === "startMic") {
      capture.start().catch((err) => {
        console.error("[glasses] capture start failed", err);
        if (state.phase === "recording") {
          state = { ...state, phase: "idle" };
          scheduleRender(state);
        }
      });
    }
    else if (e.kind === "stopMic") {
      capture.stop().catch((err) => {
        console.error("[glasses] capture stop failed", err);
      });
    }
    else if (e.kind === "exit") bridge.shutDownPageContainer(1);
  }

  function applyGesture(g: Gesture, index?: number): void {
    clearNoticeTimer();
    if (glassesView === "setup") {
      if (g === "doubleClick") bridge.shutDownPageContainer(1);
      return;
    }

    if (state.screen === "list" && (g === "scrollUp" || g === "scrollDown")) lastListScrollAt = Date.now();

    const prevLoadingFor = state.history.loadingFor;
    // Resolve the tap against what is ON SCREEN — the list re-sorts underneath us.
    const r = dispatch(state, g, index, pages.snapshot());
    state = r.state;
    if (state.notice) armNoticeTimer();
    for (const e of r.effects) runEffect(e);
    // Page transitions (list ↔ session) ride inside the serialized renderer.
    scheduleRender(state);
    historyWatch.update(prevLoadingFor, state.history.loadingFor);
  }

  let torn = false;
  function teardown(): void {
    if (torn) return;
    torn = true;
    clearNoticeTimer();
    historyWatch.dispose();
    off();
    capture.stop().catch(() => {});
    stopSessionsRetry();
    client.disconnect();
  }

  const off = bridge.onEvenHubEvent((e) => {
    capture.handleEvent(e);
    const et = e.sysEvent?.eventType ?? e.listEvent?.eventType ?? e.textEvent?.eventType;
    if (et === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      // Persist only a KNOWN OWN session: a foreign or unknown id must never
      // overwrite the saved G2 session — skip rather than clear.
      const activeId = state.sessions.active;
      if (profile && activeId && isKnownOwnSession(state.sessions.items, activeId)) {
        fireAndForget(updateActiveSession(bridge, profile, activeId));
      }
      return;
    }
    if (et === OsEventTypeList.SYSTEM_EXIT_EVENT || et === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      teardown();
      return;
    }
    routeEvent(e, {
      onClick: listGestures.onClick,
      onDoubleClick: listGestures.onDoubleClick,
      onLongPress: listGestures.onLongPress,
      onScrollUp: listGestures.onScrollUp,
      onScrollDown: listGestures.onScrollDown,
    });
  });

  window.addEventListener("beforeunload", teardown);
  console.log("[glasses] ready");
}

function profileIsReady(profile: ConnectionProfile | null): profile is ConnectionProfile {
  return isConfiguredProfile(profile);
}

boot().catch((err) => console.error("[glasses] boot failed", err));
