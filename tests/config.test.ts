import { describe, it, expect } from "vitest";
import { herdrSectionError } from "../src/config";

describe("herdr section errors", () => {
  it("treats a missing section as off and reports each misconfiguration exactly once", () => {
    // Off is a valid state — never an error.
    expect(herdrSectionError(undefined)).toBeNull();
    expect(herdrSectionError({ url: "", token: "" })).toBeNull();
    // URL without token.
    expect(herdrSectionError({ url: "wss://g2-bridge.taile61e1.ts.net/herdr", token: "" })).toBe(
      "Relay token is required when a relay URL is set.",
    );
    // Token without URL.
    expect(herdrSectionError({ url: "", token: "relay-tok" })).toBe(
      "Relay URL is required (wss://…/herdr).",
    );
    // Bad scheme (input arrives trimmed via normalizeHerdrSection).
    expect(herdrSectionError({ url: "https://g2-bridge.taile61e1.ts.net/herdr", token: "relay-tok" })).toBe(
      "Relay URL must start with wss:// or ws://. Herdr stays off until fixed.",
    );
    // Valid ws/wss sections pass.
    expect(herdrSectionError({ url: "wss://g2-bridge.taile61e1.ts.net/herdr", token: "relay-tok" })).toBeNull();
    expect(herdrSectionError({ url: "ws://127.0.0.1:8700", token: "relay-tok" })).toBeNull();
  });
});
