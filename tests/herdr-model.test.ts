import { describe, it, expect } from "vitest";
import { getAdvW } from "@evenrealities/pretext";
import {
  HERDR_MARKER,
  formatHerdrRow,
  herdrId,
  herdrSectionHeader,
  herdrTerminalsFromListReply,
  orderedHerdrRows,
  stripAnsi,
  toHerdrRow,
} from "../src/herdr/model";
import type { AnySessionId, HerdrTerminal } from "../src/herdr/model";

const terminal = (over: Partial<HerdrTerminal> = {}): HerdrTerminal => ({
  address: "t7",
  name: "build",
  argv: ["npm", "run", "build"],
  cwd: "/repo",
  state: "running",
  exit_code: null,
  created_ms: 100_000_000,
  finished_ms: null,
  ...over,
});

describe("toHerdrRow (wire → row)", () => {
  it("maps a running terminal to a live row with argv joined and seconds updated", () => {
    const row = toHerdrRow(terminal());
    expect(row).toEqual({
      kind: "herdr",
      address: "t7",
      name: "build",
      state: "live",
      argv: "npm run build",
      cwd: "/repo",
      updated: 100_000, // created_ms / 1000, same unit as SessionItem.updated
      exitCode: null,
    });
  });

  it("maps a terminal with finished_ms to a finished row carrying its exit code", () => {
    const row = toHerdrRow(terminal({ state: "finished", finished_ms: 100_005_000, exit_code: 0 }));
    expect(row.state).toBe("finished");
    expect(row.exitCode).toBe(0);
  });

  it("accepts argv as a flat string and maps unknown states to idle", () => {
    const row = toHerdrRow(terminal({ argv: "make -j4", state: "mysterious" }));
    expect(row.argv).toBe("make -j4");
    expect(row.state).toBe("idle");
  });

  it("falls back to the address when the relay sends an empty name", () => {
    expect(toHerdrRow(terminal({ name: "" })).name).toBe("t7");
    expect(toHerdrRow(terminal({ name: "  " })).name).toBe("t7");
  });
});

describe("herdrTerminalsFromListReply", () => {
  it("returns the validated terminals of a herdr.list reply", () => {
    expect(herdrTerminalsFromListReply([terminal({ address: "t1" }), terminal({ address: "t2" })])).toHaveLength(2);
  });

  it("silently drops malformed entries and non-array payloads (never blocks the UI)", () => {
    expect(herdrTerminalsFromListReply([terminal(), { nope: 1 }, null])).toHaveLength(1);
    expect(herdrTerminalsFromListReply({})).toEqual([]);
    expect(herdrTerminalsFromListReply(null)).toEqual([]);
    expect(herdrTerminalsFromListReply("nope")).toEqual([]);
  });
});

describe("orderedHerdrRows", () => {
  it("sorts newest-first like the Hermes ordering function, stable on ties", () => {
    const rows = orderedHerdrRows([
      toHerdrRow(terminal({ address: "old", created_ms: 100_000_000 })),
      toHerdrRow(terminal({ address: "new", created_ms: 100_030_000 })),
      toHerdrRow(terminal({ address: "mid", created_ms: 100_020_000 })),
      toHerdrRow(terminal({ address: "tie", created_ms: 100_020_000 })),
    ]);
    expect(rows.map((r) => r.address)).toEqual(["new", "mid", "tie", "old"]);
  });
});

describe("stripAnsi (plain-text by construction)", () => {
  it("removes CSI sequences, OSC titles, and two-char escapes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b]0;window title\x07plain")).toBe("plain");
    expect(stripAnsi("a\x1bMb")).toBe("ab");
    expect(stripAnsi("\x1b[2K\rclean")).toBe("\rclean");
  });

  it("keeps ordinary text byte-identical", () => {
    expect(stripAnsi("no escapes 123 · ＋ ●")).toBe("no escapes 123 · ＋ ●");
  });
});

describe("list row rendering", () => {
  // terminal() defaults to created_ms 100_000_000 ⇒ updated = 100_000 s.
  const now = 100_030;

  it("marks herdr rows with a stable glyph the wearer can tell apart from hermes rows", () => {
    const row = formatHerdrRow(toHerdrRow(terminal()), now);
    expect(row.startsWith(`${HERDR_MARKER} `)).toBe(true);
    expect(row).toContain("build");
    expect(row.endsWith(" · live")).toBe(true);
  });

  it("shows the finished badge for finished rows", () => {
    expect(formatHerdrRow(toHerdrRow(terminal({ finished_ms: 1, exit_code: 3 })), now)).toContain("· finished");
  });

  it("stays inside the 64-char / 63-byte row budget however long the name", () => {
    const utf8 = new TextEncoder();
    const long = toHerdrRow(terminal({ name: "ü".repeat(120), created_ms: 100_000_000 }));
    const row = formatHerdrRow(long, now);
    expect(row.length).toBeLessThanOrEqual(64);
    expect(utf8.encode(row).length).toBeLessThanOrEqual(63);
  });

  it("renders the relative age like hermes rows do", () => {
    // 30s old ⇒ "now"; 130s ⇒ "2m" — the shared compactAge buckets apply.
    expect(formatHerdrRow(toHerdrRow(terminal()), now)).toContain(" now ");
    expect(formatHerdrRow(toHerdrRow(terminal()), now + 100)).toContain(" 2m ");
  });
});

describe("section header + ids", () => {
  it("section header names the row count", () => {
    expect(herdrSectionHeader(0)).toBe("herdr · 0");
    expect(herdrSectionHeader(3)).toBe("herdr · 3");
  });

  it("herdrId builds the tagged-union member", () => {
    const id: AnySessionId = herdrId("t7");
    expect(id).toEqual({ kind: "herdr", address: "t7" });
  });
});

describe("firmware glyph coverage for the herdr marker", () => {
  it("◇ has a real glyph (raw advW > 0) and every char of the section header does too", () => {
    expect(getAdvW(HERDR_MARKER.codePointAt(0) as number)).toBeGreaterThan(0);
    for (const ch of herdrSectionHeader(12)) {
      expect(getAdvW(ch.codePointAt(0) as number)).toBeGreaterThan(0);
    }
  });

  it("pins the known-bad glyph: ⟐ (U+27D0) has NO glyph — the reason ◇ is the marker", () => {
    expect(getAdvW("⟐".codePointAt(0) as number)).toBe(0);
  });
});
