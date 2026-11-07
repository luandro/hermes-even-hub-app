import { waitForEvenAppBridge, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import "./style.css";
import { loadBridgeDefaults } from "./config";
import { BridgeClient } from "./net/ws-client";
import { initialState, reduce, markDeliveryUncertain, type AppState } from "./state/store";
import { createLoadingStartup, createSetupStartup, showListPage, showLoadingPage, showSessionPage } from "./ui/render";
import { loadingText, renderSession, buildListView, type ListView } from "./ui/views";
import { renderPhoneSetup } from "./ui/phone";
import { routeEvent, type ListSelection } from "./input/router";
import { dispatch, type Gesture, type Effect } from "./input/dispatch";
import { sessionsList } from "./protocol";
import { serializeLatest } from "./util/coalesce";
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

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Missing #app root");

  const bridge = await waitForEvenAppBridge();
  const defaults = loadBridgeDefaults();
  let profile = await loadConnectionProfile(bridge);
  let state: AppState = initialState();
  let phoneErrors: string[] = [];
  let glassesView: "setup" | "list" = profileIsReady(profile) ? "list" : "setup";
  let shownList: ListView = buildListView(state);
  let visibleListRows = shownList.rows;
  /** When the wearer last scrolled the list — a rebuild while reading is hostile. */
  let lastListScrollAt = 0;
  /** Whether the list page is the one currently built on the glasses. */
  let listRendered = false;
  let helloOk = false;
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

  const scheduleRender = serializeLatest(async (s: AppState) => {
    if (glassesView === "setup") return;
    if (s.screen === "list") {
      if (!s.sessionsLoaded) {
        await showLoadingPage(bridge, loadingText(s));
        return;
      }
      const next = buildListView(s);
      // A list cannot be updated in place, so every render is a full rebuild —
      // and a rebuild throws away the native scroll position and selection.
      // Two guards, because `sessions` frames arrive on their own schedule and
      // would otherwise yank the wearer back to the top mid-scroll:
      //   1. identical rows → nothing to show, skip
      //   2. scrolled in the last few seconds → they are reading, defer
      const unchanged =
        next.rows.length === shownList.rows.length && next.rows.every((r, i) => r === shownList.rows[i]);
      const browsing = Date.now() - lastListScrollAt < LIST_SCROLL_GRACE_MS;
      if (listRendered && (unchanged || browsing)) return;

      // Only adopt the snapshot when it is actually drawn — a tap resolves
      // against it, so a stale one would open the wrong row.
      shownList = next;
      visibleListRows = next.rows;
      listRendered = true;
      await showListPage(bridge, next.rows);
      return;
    }
    listRendered = false;
    await renderSession(bridge, s);
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
      if (helloOk && !state.sessionsLoaded) client.send(sessionsList());
    }, 2000);
  };

  const stopSessionsRetry = (): void => {
    clearInterval(sessionsRetryTimer);
    sessionsRetryTimer = undefined;
  };

  const client = new BridgeClient({
    onMessage: (m) => {
      state = reduce(state, m);
      scheduleRender(state);
      if (m.t === "ack") {
        clearDeliveryTimer(m.id);
        if (!m.ok) armNoticeTimer();
      }
      if (m.t === "hello.ok") {
        helloOk = true;
        client.send(sessionsList());
        startSessionsRetry();
        persistActiveSession(m.active);
      }
      if (m.t === "sessions") stopSessionsRetry();
      if (m.t === "active") persistActiveSession(m.id);
      if (m.t === "notice") {
        armNoticeTimer();
      }
    },
    onStatus: setStatus,
    onDisconnected: () => {
      clearAllDeliveryTimers();
      const prev = state;
      state = markDeliveryUncertain(state);
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
    helloOk = false;
    client.connect(profile);
    renderPhone();
  }

  renderPhone();
  if (profileIsReady(profile)) {
    helloOk = false;
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

  function selectedListIndex(selection?: ListSelection): number | undefined {
    if (selection?.index !== undefined) return selection.index;
    if (selection?.name !== undefined) {
      const index = visibleListRows.indexOf(selection.name);
      return index >= 0 ? index : -1;
    }
    return undefined;
  }

  async function applyGesture(g: Gesture, index?: number): Promise<void> {
    clearNoticeTimer();
    if (glassesView === "setup") {
      if (g === "doubleClick") bridge.shutDownPageContainer(1);
      return;
    }

    const prevScreen = state.screen;
    if (state.screen === "list" && (g === "scrollUp" || g === "scrollDown")) lastListScrollAt = Date.now();

    // Resolve the tap against what is ON SCREEN — the list re-sorts underneath us.
    const r = dispatch(state, g, index, shownList);
    state = r.state;
    for (const e of r.effects) runEffect(e);
    if (state.screen !== prevScreen) {
      if (state.screen === "list") {
        shownList = buildListView(state);
        visibleListRows = shownList.rows;
        listRendered = true;
        await showListPage(bridge, visibleListRows);
      }
      else {
        listRendered = false;
        await showSessionPage(bridge);
      }
    }
    scheduleRender(state);
  }

  let torn = false;
  function teardown(): void {
    if (torn) return;
    torn = true;
    clearNoticeTimer();
    off();
    capture.stop().catch(() => {});
    stopSessionsRetry();
    client.disconnect();
  }

  const off = bridge.onEvenHubEvent((e) => {
    capture.handleEvent(e);
    const et = e.sysEvent?.eventType ?? e.listEvent?.eventType ?? e.textEvent?.eventType;
    if (et === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      if (profile) fireAndForget(updateActiveSession(bridge, profile, state.sessions.active ?? ""));
      return;
    }
    if (et === OsEventTypeList.SYSTEM_EXIT_EVENT || et === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      teardown();
      return;
    }
    routeEvent(e, {
      onClick: (selection) => { fireAndForget(applyGesture("click", selectedListIndex(selection))); },
      onDoubleClick: () => { fireAndForget(applyGesture("doubleClick")); },
      onScrollUp: () => { fireAndForget(applyGesture("scrollUp")); },
      onScrollDown: () => { fireAndForget(applyGesture("scrollDown")); },
    });
  });

  window.addEventListener("beforeunload", teardown);
  console.log("[glasses] ready");
}

function profileIsReady(profile: ConnectionProfile | null): profile is ConnectionProfile {
  return isConfiguredProfile(profile);
}

boot().catch((err) => console.error("[glasses] boot failed", err));
