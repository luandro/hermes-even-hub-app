import { describe, expect, it } from "vitest";
import { getAdvW, getTextWidth } from "@evenrealities/pretext";
import { HINTS } from "../src/state/store";
import { NEW_SESSION_ROW } from "../src/ui/session-list";

// Missing glyphs are dropped SILENTLY by the firmware font: raw advance width 0,
// rendered as a 4px placeholder box (getAdvW maps raw-0/cp>=32 to 4). So
// getTextWidth alone can NOT prove coverage — every string measures > 0 even
// when built from missing glyphs. The honest check is the RAW advance width,
// asserted per character below.
describe("firmware glyph coverage", () => {
  // PT-BR readiness: ã ç é ê õ í all need real glyphs.
  const strings = [...Object.values(HINTS), NEW_SESSION_ROW, "ãçéêõí"];

  it("every character in HINTS and the new-session row has a real glyph (raw advW > 0)", () => {
    for (const text of strings) {
      for (const ch of text) {
        expect(
          getAdvW(ch.codePointAt(0) ?? 0),
          `glyph ${JSON.stringify(ch)} in ${JSON.stringify(text)}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  // Version-compat pin: this documents CURRENT firmware/pretext behavior (the
  // lock emoji has no glyph and renders as a 4px placeholder box). If a font
  // update ever gives 🔒 a real glyph, this failing is the signal to revisit
  // every "no emoji" assumption in HINTS — not a bug in the check.
  it("pins the known-bad glyph: 🔒 has NO glyph (raw advW 0, placeholder width 4)", () => {
    expect(getAdvW("🔒".codePointAt(0) ?? 0)).toBe(0);
    expect(getTextWidth("🔒")).toBe(4); // placeholder box, not a glyph — unusable on the G2
  });
});
