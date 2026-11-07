import { describe, expect, it } from "vitest";
import { sessionListRows } from "../src/ui/session-list";

const utf8 = new TextEncoder();

describe("sessionListRows", () => {
  it("keeps same-age untitled sessions visually distinct", () => {
    const rows = sessionListRows([
      { id: "20260603_214928_c173a316", title: "New session", updated: 1_780_000_000 },
      { id: "20260603_214450_6b8e5adb", title: "New session", updated: 1_780_000_000 },
    ], null, 1_780_000_000);

    expect(rows.slice(1)).toEqual([
      "  now New session a316",
      "  now New session 5adb",
    ]);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("keeps every rendered row within the firmware byte limit", () => {
    const rows = sessionListRows([
      {
        id: "long",
        title: "A very long session title with multibyte symbols ●＋ and enough text to overflow the list item byte validator",
        updated: 1_780_000_000,
      },
    ], "long", 1_780_000_030);

    expect(rows.every((row) => utf8.encode(row).length <= 63)).toBe(true);
  });

  it("does not append (read-only) if title already starts with a lock emoji", () => {
    const rows = sessionListRows([
      {
        id: "ro-1",
        title: "🔒 Telegram chat",
        updated: 1_780_000_000,
        read_only: true,
      },
    ], null, 1_780_000_000);

    expect(rows[1]).toBe("  now 🔒 Telegram chat");
    expect(utf8.encode(rows[1]).length).toBeLessThanOrEqual(63);
  });

  it("appends (read-only) if title does not start with a lock emoji", () => {
    const rows = sessionListRows([
      {
        id: "ro-2",
        title: "Telegram chat",
        updated: 1_780_000_000,
        read_only: true,
      },
    ], null, 1_780_000_000);

    expect(rows[1]).toBe("  now Telegram chat (read-only)");
    expect(utf8.encode(rows[1]).length).toBeLessThanOrEqual(63);
  });

  it("ensures (read-only) survives truncation on long titles and respects byte limit", () => {
    const rows = sessionListRows([
      {
        id: "ro-long",
        title: "A very long Telegram conversation about planning and release schedule with multiple topics",
        updated: 1_780_000_000,
        read_only: true,
      },
    ], null, 1_780_000_000);

    expect(rows[1]).toContain("(read-only)");
    expect(utf8.encode(rows[1]).length).toBeLessThanOrEqual(63);
  });

  it("drops age suffix if needed to fit (read-only)", () => {
    // Title fits pixel width and length, but with "now" age (64 bytes) exceeds 63 bytes.
    // Without age (60 bytes), it fits completely without truncation.
    const title = "Project chat session discussions list iiiiiiii";
    const rows = sessionListRows([
      {
        id: "ro-drop-age",
        title,
        updated: 1_780_000_000,
        read_only: true,
      },
    ], null, 1_780_000_000);

    expect(rows[1]).toBe(`  ${title} (read-only)`);
    expect(utf8.encode(rows[1]).length).toBeLessThanOrEqual(63);
  });
});
