import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderPhoneSetup } from "../src/ui/phone";
import type { SessionItem } from "../src/protocol";

type Listener = (event?: unknown) => void;

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  children: FakeElement[] = [];
  type = "";
  name = "";
  value = "";
  placeholder = "";
  autocomplete = "";
  autocapitalize = "";
  spellcheck = false;
  inputMode = "";
  disabled = false;
  hidden = false;
  open = false;
  listeners: Record<string, Listener[]> = {};

  constructor(tag: string) {
    this.tagName = tag;
  }
  append(...nodes: (FakeElement | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const textNode = new FakeElement("#text");
        textNode.textContent = n;
        this.children.push(textNode);
      } else {
        this.children.push(n);
      }
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [...nodes];
  }
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string) {
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault: () => {} });
  }
  setAttribute() {}
  select() {}
}

function collectTextAndPlaceholders(el: FakeElement): { texts: string[]; placeholders: string[] } {
  const texts: string[] = [];
  const placeholders: string[] = [];
  function walk(node: FakeElement) {
    if (node.textContent) texts.push(node.textContent);
    if (node.placeholder) placeholders.push(node.placeholder);
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(el);
  return { texts, placeholders };
}

/** Every descendant whose tagName matches (depth-first). */
function findAll(el: FakeElement, tag: string): FakeElement[] {
  const out: FakeElement[] = [];
  function walk(node: FakeElement) {
    if (node.tagName === tag) out.push(node);
    for (const child of node.children) walk(child);
  }
  walk(el);
  return out;
}

function findButtonByText(el: FakeElement, text: string): FakeElement | undefined {
  return findAll(el, "button").find((b) => b.textContent === text);
}

function sessionRows(el: FakeElement): FakeElement[] {
  return findAll(el, "article");
}

function rowById(el: FakeElement, id: string): FakeElement | undefined {
  return sessionRows(el).find((r) => findAll(r, "code").some((c) => c.textContent === id));
}

const baseState = {
  profile: null,
  defaults: { url: "", token: "" },
  status: "not configured",
  errors: [] as string[],
};

describe("phone setup help and placeholder", () => {
  const origDoc = (globalThis as any).document;

  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => new FakeElement(tag),
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
    vi.unstubAllGlobals();
  });

  it("advertises port 443 and whitelisted host instead of 8443 in help text and placeholder", () => {
    const root = new FakeElement("div");
    renderPhoneSetup(
      root as unknown as HTMLElement,
      { ...baseState },
      {
        onSaveConnect: () => {},
        onDisconnect: () => {},
        onRefreshSessions: () => {},
        onSwitchSession: () => {},
        onSettingsSet: () => {},
        onSaveDevice: () => {},
      },
    );

    const { texts, placeholders } = collectTextAndPlaceholders(root);
    const allHelpAndPlaceholders = [...texts, ...placeholders].join("\n");

    expect(allHelpAndPlaceholders).not.toContain("8443");
    expect(allHelpAndPlaceholders).toContain("tailscale serve --https=443");
    expect(allHelpAndPlaceholders).toContain("wss://g2-bridge.taile61e1.ts.net");
    expect(placeholders).toContain("wss://g2-bridge.taile61e1.ts.net");
  });
});

describe("phone sessions panel", () => {
  const origDoc = (globalThis as any).document;
  let clipboardWrites: string[];

  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => new FakeElement(tag),
    };
    clipboardWrites = [];
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async (text: string) => { clipboardWrites.push(text); } },
    });
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
    vi.unstubAllGlobals();
  });

  const sessions: SessionItem[] = [
    { id: "tg-1", title: "🔒 Connectivity ping check", updated: 2000, tokens: 42, foreign: true, read_only: true, platform: "telegram" },
    { id: "g2-1", title: "List Comapeo session tasks", updated: 1000, tokens: 7, platform: "even_g2" },
  ];

  function render(overrides: Record<string, unknown> = {}) {
    const root = new FakeElement("div");
    const actions = {
      onSaveConnect: () => {},
      onDisconnect: () => {},
      onRefreshSessions: () => {},
      onSwitchSession: () => {},
      onSettingsSet: () => {},
      onSaveDevice: () => {},
    };
    renderPhoneSetup(
      root as unknown as HTMLElement,
      {
        ...baseState,
        status: "connected",
        sessions,
        activeSession: "g2-1",
        sessionsLoaded: true,
        caps: {
          profile: "alpha",
          net_mode: "both",
          asr_active: "whisper-tiny",
          asr_models: ["whisper-tiny", "parakeet-tdt-0.6b-v2"],
          asr_env_pinned: false,
          auto_approve_timeout_s: 0,
        },
        ...overrides,
      },
      actions,
    );
    return { root, actions };
  }

  it("lists telegram and glasses sessions newest-first with origin badges", () => {
    const { root } = render();
    const rows = sessionRows(root);
    expect(rows).toHaveLength(2);
    expect(rowById(root, "tg-1")).toBeTruthy();
    expect(rowById(root, "g2-1")).toBeTruthy();
    // Telegram row first (updated 2000 > 1000) and badged; lock stripped from title.
    const first = rows[0];
    const texts = collectTextAndPlaceholders(first).texts.join(" ");
    expect(texts).toContain("Telegram");
    expect(texts).toContain("Connectivity ping check");
    expect(texts).not.toContain("🔒 Connectivity ping check");
    expect(collectTextAndPlaceholders(rows[1]).texts.join(" ")).toContain("Glasses");
  });

  it("copies the exact /resume payload for telegram rows", async () => {
    const { root } = render();
    const row = rowById(root, "tg-1")!;
    const copyButton = findAll(row, "button").find((b) => b.textContent === "Copy /resume");
    expect(copyButton).toBeTruthy();
    copyButton!.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(clipboardWrites).toEqual(["/resume tg-1"]);
    expect(copyButton!.textContent).toBe("Copied!");
  });

  it("falls back to execCommand copy when clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const doc = (globalThis as any).document as any;
    const exec = vi.fn(() => true);
    doc.createElement = (tag: string) => new FakeElement(tag);
    doc.body = { appendChild: () => {}, removeChild: () => {} };
    doc.execCommand = exec;
    const { root } = render();
    const row = rowById(root, "tg-1")!;
    const copyButton = findAll(row, "button").find((b) => b.textContent === "Copy /resume")!;
    copyButton.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(exec).toHaveBeenCalledWith("copy");
    expect(copyButton.textContent).toBe("Copied!");
  });

  it("offers Open on glasses (not /resume) for glasses rows and marks the active one", () => {
    const { root } = render();
    const row = rowById(root, "g2-1")!;
    const buttons = findAll(row, "button").map((b) => b.textContent);
    expect(buttons).not.toContain("Copy /resume");
    expect(buttons).toContain("Copy ID");
    expect(collectTextAndPlaceholders(row).texts.join(" ")).toContain("Active");
    expect(collectTextAndPlaceholders(row).texts.join(" ")).toContain("cannot /resume in Telegram");
  });

  it("dispatches onSwitchSession from Open on glasses", () => {
    const other: SessionItem[] = [
      { id: "g2-2", title: "Another glasses session", updated: 500, platform: "even_g2" },
    ];
    const { root, actions } = render({ sessions: other, activeSession: "g2-1" });
    const spy = vi.spyOn(actions, "onSwitchSession");
    const row = rowById(root, "g2-2")!;
    findButtonByText(row, "Open on glasses")!.fire("click");
    expect(spy).toHaveBeenCalledWith("g2-2");
  });

  it("dispatches onRefreshSessions from the Refresh button", () => {
    const { root, actions } = render();
    const spy = vi.spyOn(actions, "onRefreshSessions");
    findButtonByText(root, "Refresh")!.fire("click");
    expect(spy).toHaveBeenCalled();
  });

  it("shows a loading state before the first sessions frame", () => {
    const { root } = render({ sessionsLoaded: false, sessions: [], activeSession: null });
    expect(collectTextAndPlaceholders(root).texts.join(" ")).toContain("Loading sessions");
  });

  it("filter tabs hide non-matching rows", () => {
    const { root } = render();
    const tabs = findAll(root, "button").filter((b) =>
      ["All", "Telegram", "Glasses"].includes(b.textContent));
    expect(tabs.map((t) => t.textContent)).toEqual(["All", "Telegram", "Glasses"]);
    const telegramTab = tabs.find((t) => t.textContent === "Telegram")!;
    telegramTab.fire("click");
    expect(rowById(root, "tg-1")!.hidden).toBe(false);
    expect(rowById(root, "g2-1")!.hidden).toBe(true);
  });
});

describe("phone settings panel", () => {
  const origDoc = (globalThis as any).document;

  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => new FakeElement(tag),
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
    vi.unstubAllGlobals();
  });

  const caps = {
    profile: "alpha",
    net_mode: "both",
    asr_active: "whisper-tiny",
    asr_models: ["whisper-tiny", "parakeet-tdt-0.6b-v2"],
    asr_env_pinned: false,
    auto_approve_timeout_s: 0,
  };

  function render(overrides: Record<string, unknown> = {}) {
    const root = new FakeElement("div");
    const actions = {
      onSaveConnect: () => {},
      onDisconnect: () => {},
      onRefreshSessions: () => {},
      onSwitchSession: () => {},
      onSettingsSet: () => {},
      onSaveDevice: () => {},
    };
    renderPhoneSetup(
      root as unknown as HTMLElement,
      {
        ...baseState,
        status: "connected",
        sessionsLoaded: true,
        sessions: [],
        activeSession: "g2-9",
        caps,
        ...overrides,
      },
      actions,
    );
    return { root, actions };
  }

  it("renders device input defaulting to g2 and read-only diagnostic pills", () => {
    const { root } = render();
    const device = findAll(root, "input").find((i) => i.name === "device")!;
    expect(device).toBeTruthy();
    expect(device.value).toBe("g2");
    const texts = collectTextAndPlaceholders(root).texts.join(" ");
    expect(texts).toContain("alpha");       // profile pill
    expect(texts).toContain("both");        // net_mode pill
    expect(texts).toContain("whisper-tiny");// asr_active pill
    expect(texts).toContain("g2-9");        // active session pill
  });

  it("renders the ASR model selector with caps models and dispatches changes", () => {
    const { root, actions } = render();
    const spy = vi.spyOn(actions, "onSettingsSet");
    const selects = findAll(root, "select");
    const asr = selects.find((s) => s.name === "asr_model")!;
    expect(asr).toBeTruthy();
    const optionTexts = findAll(asr, "option").map((o) => o.textContent);
    expect(optionTexts).toContain("whisper-tiny");
    expect(optionTexts).toContain("parakeet-tdt-0.6b-v2");
    asr.value = "parakeet-tdt-0.6b-v2";
    asr.fire("change");
    expect(spy).toHaveBeenCalledWith({ asr_model: "parakeet-tdt-0.6b-v2" });
  });

  it("renders the auto-approve timeout selector and dispatches changes", () => {
    const { root, actions } = render();
    const spy = vi.spyOn(actions, "onSettingsSet");
    const timeout = findAll(root, "select").find((s) => s.name === "auto_approve_timeout_s")!;
    expect(timeout).toBeTruthy();
    const optionTexts = findAll(timeout, "option").map((o) => o.textContent);
    expect(optionTexts).toEqual(["Off", "10s", "15s", "30s"]);
    timeout.value = "15";
    timeout.fire("change");
    expect(spy).toHaveBeenCalledWith({ auto_approve_timeout_s: 15 });
  });

  it("disables live settings controls while disconnected or env-pinned", () => {
    const { root } = render({ status: "disconnected", caps: { ...caps, asr_env_pinned: true } });
    const asr = findAll(root, "select").find((s) => s.name === "asr_model")!;
    const timeout = findAll(root, "select").find((s) => s.name === "auto_approve_timeout_s")!;
    expect(asr.disabled).toBe(true);
    expect(timeout.disabled).toBe(true);
  });

  it("dispatches onSaveDevice with the entered device id", () => {
    const { root, actions } = render();
    const spy = vi.spyOn(actions, "onSaveDevice");
    const device = findAll(root, "input").find((i) => i.name === "device")!;
    device.value = "g2-lab";
    findButtonByText(root, "Save device")!.fire("click");
    expect(spy).toHaveBeenCalledWith("g2-lab");
  });
});
