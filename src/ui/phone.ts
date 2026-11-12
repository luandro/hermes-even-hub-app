import type { BridgeDefaults } from "../config";
import type { ConnectionProfile } from "../storage/persist";
import type { SessionItem } from "../protocol";
import { compactAge, orderedSessions } from "./session-list";

/** Bridge capability snapshot from `hello.ok` (older bridges send `{}`). */
export interface PhoneCaps {
  profile?: unknown;
  net_mode?: unknown;
  asr_active?: unknown;
  asr_models?: unknown;
  asr_env_pinned?: unknown;
  auto_approve_timeout_s?: unknown;
}

interface PhoneSetupState {
  profile: ConnectionProfile | null;
  defaults: BridgeDefaults;
  status: string;
  errors: string[];
  sessions?: SessionItem[];
  activeSession?: string | null;
  sessionsLoaded?: boolean;
  caps?: PhoneCaps | null;
}

export interface PhoneSettings {
  asr_model?: string;
  auto_approve_timeout_s?: number;
}

export interface PhoneSetupActions {
  onSaveConnect: (url: string, token: string) => void;
  onDisconnect: () => void;
  /** Refresh button — re-requests the session list. */
  onRefreshSessions: () => void;
  /** "Open on glasses" — switch the glasses to this (own) session. */
  onSwitchSession: (id: string) => void;
  /** Live bridge settings (`settings.set` frame). */
  onSettingsSet: (settings: PhoneSettings) => void;
  /** Persist the hello device id (takes effect on reconnect). */
  onSaveDevice: (device: string) => void;
}

/** Foreign rows (telegram by platform, or any row the bridge flags foreign). */
function isTelegramSession(item: SessionItem): boolean {
  return item.platform === "telegram" || item.foreign === true;
}

/** Foreign-row badge label: the owning surface's name, not a hardcoded one. */
function foreignBadgeLabel(item: SessionItem): string {
  if (item.platform === "telegram") return "Telegram";
  return item.platform || "foreign";
}

function stripLock(title: string): string {
  return title.replace(/^🔒\s*/, "");
}

export function renderPhoneSetup(
  root: HTMLElement,
  state: PhoneSetupState,
  actions: PhoneSetupActions,
): void {
  const shell = el("main", "setup-shell");
  const panel = el("section", "setup-panel");
  const form = el("form", "setup-form");
  const url = input("url", "url", state.profile?.url || state.defaults.url, "wss://g2-bridge.taile61e1.ts.net");
  const token = input("password", "token", state.profile?.token || state.defaults.token, "Shared bridge token");
  const header = el("header", "setup-header");
  const status = el("p", `setup-status ${statusClass(state.status)}`, statusText(state.status));
  const title = el("h1", "", "Hermes");
  const intro = el("p", "setup-copy", "G2 bridge connection");
  const updated = state.profile?.updatedAt
    ? el("p", "setup-meta", `Last saved ${new Date(state.profile.updatedAt).toLocaleString()}`)
    : el("p", "setup-meta", "No saved bridge profile");
  const actionsRow = el("div", "setup-actions");
  const save = button("submit", "Save and connect");
  const disconnect = button("button", "Disconnect");
  disconnect.disabled = state.status === "not configured" || state.status === "disconnected";
  disconnect.addEventListener("click", actions.onDisconnect);
  actionsRow.append(save, disconnect);
  header.append(el("div", "setup-title", "", [title, intro]), status);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.onSaveConnect(url.value, token.value);
  });

  form.append(label("Bridge URL", url), label("Token", token), actionsRow);
  panel.append(
    header,
    updated,
    errorList(state.errors),
    form,
    sessionsPanel(state, actions),
    settingsPanel(state, actions),
    helpBlock(),
  );
  shell.append(panel);
  root.replaceChildren(shell);
}

// ── Sessions panel ───────────────────────────────────────────────────────────

type SessionFilter = "all" | "telegram" | "glasses";

const FILTERS: { key: SessionFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "telegram", label: "Telegram" },
  { key: "glasses", label: "Glasses" },
];

function rowMatches(item: SessionItem, filter: SessionFilter): boolean {
  if (filter === "all") return true;
  return filter === "telegram" ? isTelegramSession(item) : !isTelegramSession(item);
}

function sessionsPanel(state: PhoneSetupState, actions: PhoneSetupActions): HTMLElement {
  const section = el("section", "phone-panel sessions-panel");
  const header = el("div", "panel-header");
  const refresh = button("button", "Refresh");
  refresh.disabled = state.status !== "connected" && state.status !== "reconnecting";
  refresh.addEventListener("click", () => actions.onRefreshSessions());
  header.append(el("h2", "panel-title", "Sessions"), refresh);

  const tabs = el("div", "filter-tabs");
  const rowsEl = el("div", "session-rows");
  const items = state.sessions ?? [];
  const rowRefs: { row: HTMLElement; item: SessionItem }[] = [];
  for (const item of orderedSessions(items)) {
    rowRefs.push({ row: sessionRow(item, state.activeSession ?? null, actions), item });
  }
  for (const { row } of rowRefs) rowsEl.append(row);

  const tabRefs: { tab: HTMLButtonElement; key: SessionFilter }[] = [];
  for (const { key, label } of FILTERS) {
    const tab = button("button", label);
    tab.className = key === "all" ? "filter-tab is-active" : "filter-tab";
    tab.addEventListener("click", () => {
      for (const { row, item } of rowRefs) row.hidden = !rowMatches(item, key);
      for (const ref of tabRefs) {
        ref.tab.className = ref.key === key ? "filter-tab is-active" : "filter-tab";
      }
    });
    tabRefs.push({ tab, key });
    tabs.append(tab);
  }

  const body = !state.sessionsLoaded
    ? el("p", "session-status", "Loading sessions…")
    : items.length === 0
      ? el("p", "session-status", "No sessions yet")
      : rowsEl;
  section.append(header, tabs, body);
  return section;
}

function sessionRow(item: SessionItem, active: string | null, actions: PhoneSetupActions): HTMLElement {
  const telegram = isTelegramSession(item);
  const row = el("article", `session-row ${telegram ? "is-telegram" : "is-glasses"}`);
  const main = el("div", "session-main");
  const titleLine = el("div", "session-title-line");
  titleLine.append(
    el("span", "session-title", stripLock(item.title || "New session")),
    el(
      "span",
      `origin-badge ${telegram ? "badge-telegram" : "badge-glasses"}`,
      telegram ? foreignBadgeLabel(item) : "Glasses",
    ),
  );
  // A glasses row minted by a cross-surface handoff shares its conversation
  // with the foreign leg it came from (V2).
  if (!telegram && item.handoff_from) {
    titleLine.append(el("span", "origin-badge badge-shared", "Shared"));
  }
  if (item.id === active) {
    titleLine.append(el("span", "active-badge", telegram ? "Active" : "Active on glasses"));
  }
  const meta = el("div", "session-meta");
  meta.append(
    el("span", "session-age", compactAge(item.updated, Math.floor(Date.now() / 1000))),
    el("span", "session-tokens", `${item.tokens ?? 0} tokens`),
    el("code", "session-id", item.id),
  );
  main.append(titleLine, meta);

  const actionsRow = el("div", "session-actions");
  if (telegram) {
    // Resumable foreign row: continue the conversation on the glasses via a
    // cross-surface handoff (V2); read-only rows only offer the /resume copy.
    if (!item.read_only) {
      const cont = button("button", "Continue on glasses");
      cont.addEventListener("click", () => actions.onSwitchSession(item.id));
      actionsRow.append(cont);
    }
    actionsRow.append(copyButton("Copy /resume", `/resume ${item.id}`));
    actionsRow.append(copyButton("Copy ID", item.id));
  } else {
    if (item.id !== active) {
      const open = button("button", "Open on glasses");
      open.addEventListener("click", () => actions.onSwitchSession(item.id));
      actionsRow.append(open);
    }
    // /resume <id> pasted into Telegram continues THIS glasses session there.
    actionsRow.append(copyButton("Copy /resume", `/resume ${item.id}`));
    actionsRow.append(copyButton("Copy ID", item.id));
  }

  row.append(main, actionsRow);
  return row;
}

function copyButton(labelText: string, payload: string): HTMLButtonElement {
  const b = button("button", labelText);
  b.addEventListener("click", () => {
    void copyText(payload).then((ok) => {
      if (ok) flashCopied(b);
    });
  });
  return b;
}

function flashCopied(b: HTMLButtonElement): void {
  const original = b.textContent;
  b.textContent = "Copied!";
  setTimeout(() => {
    b.textContent = original;
  }, 1500);
}

/** navigator.clipboard when available, textarea + execCommand for older WebViews. */
async function copyText(text: string): Promise<boolean> {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator;
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const doc = globalThis.document as
      | (Document & { execCommand?: (command: string) => boolean })
      | undefined;
    if (!doc?.createElement) return false;
    const area = doc.createElement("textarea");
    area.value = text;
    doc.body?.appendChild(area);
    area.select?.();
    const ok = doc.execCommand?.("copy");
    doc.body?.removeChild?.(area);
    return Boolean(ok);
  } catch {
    return false;
  }
}

// ── Settings & diagnostics panel ─────────────────────────────────────────────

const TIMEOUT_OPTIONS = [
  { label: "Off", value: "0" },
  { label: "10s", value: "10" },
  { label: "15s", value: "15" },
  { label: "30s", value: "30" },
];

function settingsPanel(state: PhoneSetupState, actions: PhoneSetupActions): HTMLElement {
  const section = el("section", "phone-panel settings-panel");
  const caps = state.caps ?? {};
  const connected = state.status === "connected";

  const deviceRow = el("div", "setting-row");
  const deviceInput = input("text", "device", state.profile?.device || "g2", "g2");
  const saveDevice = button("button", "Save device");
  saveDevice.addEventListener("click", () => actions.onSaveDevice(deviceInput.value));
  deviceRow.append(label("Device ID", deviceInput), saveDevice);

  const asrModels = Array.isArray(caps.asr_models)
    ? caps.asr_models.filter((m): m is string => typeof m === "string")
    : [];
  const asrPinned = caps.asr_env_pinned === true;
  const asrSelect = select(
    "asr_model",
    asrModels.map((m) => ({ label: m, value: m })),
    String(caps.asr_active ?? ""),
  );
  asrSelect.disabled = !connected || asrModels.length === 0 || asrPinned;
  asrSelect.addEventListener("change", () => actions.onSettingsSet({ asr_model: asrSelect.value }));

  const timeoutSelect = select(
    "auto_approve_timeout_s",
    TIMEOUT_OPTIONS,
    String(caps.auto_approve_timeout_s ?? 0),
  );
  timeoutSelect.disabled = !connected;
  timeoutSelect.addEventListener("change", () =>
    actions.onSettingsSet({ auto_approve_timeout_s: Number(timeoutSelect.value) }));

  const pills = el("div", "diag-pills");
  pills.append(
    diagPill("profile", caps.profile),
    diagPill("net_mode", caps.net_mode),
    diagPill("asr", caps.asr_active),
    diagPill("active session", state.activeSession),
  );

  section.append(
    el("h2", "panel-title", "Settings & Diagnostics"),
    deviceRow,
    label("ASR model", asrSelect),
    label("Auto-approve timeout", timeoutSelect),
    asrPinned ? el("p", "setting-note", "ASR model pinned by EVENHUB_ASR_MODEL on the bridge") : el("p", "setting-note", "Live settings apply without a bridge restart"),
    pills,
  );
  return section;
}

function diagPill(labelText: string, value: unknown): HTMLElement {
  const text = value == null || value === "" ? "—" : String(value);
  return el("span", "diag-pill", `${labelText}: ${text}`);
}

// ── shared element helpers ───────────────────────────────────────────────────

function helpBlock(): HTMLElement {
  const block = document.createElement("details");
  block.className = "setup-help";
  const summary = el("summary", "setup-help-summary");
  const action = el("span", "setup-toggle-action", "Show");
  summary.append(el("span", "", "Setup details"), action);
  const body = el("div", "setup-help-body");
  body.append(
    el("p", "", "Expose the local bridge with Tailscale Serve, then enter the WSS URL and token above."),
    code("tailscale serve --https=443 --bg http://localhost:8765"),
    code("wss://g2-bridge.taile61e1.ts.net"),
  );
  block.addEventListener("toggle", () => {
    action.textContent = block.open ? "Hide" : "Show";
  });
  block.append(
    summary,
    body,
  );
  return block;
}

function errorList(errors: string[]): HTMLElement {
  const list = el("ul", "setup-errors");
  for (const error of errors) {
    const item = el("li", "", error);
    list.append(item);
  }
  list.hidden = errors.length === 0;
  return list;
}

function input(type: string, name: string, value: string, placeholder: string): HTMLInputElement {
  const element = document.createElement("input");
  element.type = type;
  element.name = name;
  element.value = value;
  element.placeholder = placeholder;
  element.autocomplete = "off";
  element.autocapitalize = "none";
  element.spellcheck = false;
  if (type === "url") element.inputMode = "url";
  return element;
}

function select(
  name: string,
  options: { label: string; value: string }[],
  selected: string,
): HTMLSelectElement {
  const element = document.createElement("select");
  element.name = name;
  for (const opt of options) {
    const option = el("option", "", opt.label) as HTMLOptionElement;
    option.value = opt.value;
    if (opt.value === selected) option.selected = true;
    element.append(option);
  }
  if (options.length > 0 && !options.some((o) => o.value === selected)) {
    element.value = options[0].value;
  }
  return element;
}

function label(text: string, control: HTMLElement): HTMLLabelElement {
  const element = document.createElement("label");
  const span = el("span", "", text);
  element.append(span, control);
  return element;
}

function button(type: "button" | "submit", text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = type;
  element.textContent = text;
  return element;
}

function code(text: string): HTMLElement {
  return el("code", "", text);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
  children: HTMLElement[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  if (children.length) element.append(...children);
  return element;
}

function statusText(status: string): string {
  if (status === "connected") return "Connected";
  if (status === "not configured") return "Not configured";
  if (status === "disconnected") return "Disconnected";
  if (status === "reconnecting") return "Reconnecting";
  if (status === "error: bridge token rejected") return "Token rejected";
  if (status.startsWith("connecting")) return "Connecting";
  if (status.startsWith("error:")) return "Error";
  return status;
}

function statusClass(status: string): string {
  if (status === "connected") return "is-connected";
  if (status.startsWith("error:")) return "is-error";
  if (status === "not configured" || status === "disconnected") return "is-muted";
  return "is-pending";
}
