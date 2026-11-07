import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderPhoneSetup } from "../src/ui/phone";

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
  addEventListener() {}
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

describe("phone setup help and placeholder", () => {
  const origDoc = (globalThis as any).document;

  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => new FakeElement(tag),
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
  });

  it("advertises port 443 and whitelisted host instead of 8443 in help text and placeholder", () => {
    const root = new FakeElement("div");
    renderPhoneSetup(
      root as unknown as HTMLElement,
      {
        profile: null,
        defaults: { url: "", token: "" },
        status: "not configured",
        errors: [],
      },
      {
        onSaveConnect: () => {},
        onDisconnect: () => {},
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
