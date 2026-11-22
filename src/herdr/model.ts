import { compactAge, composeListRow } from "../ui/session-list";

/**
 * Phase 2: the Herdr leg. Everything Herdr lives OUTSIDE the bridge protocol
 * (`src/protocol.ts` is untouched) — the relay is a separate WebSocket with its
 * own allowlisted JSON-RPC surface. This module holds the tagged-union id type,
 * the Herdr row model, and the pure wire→row mapping.
 */

/**
 * The one id type that crosses world boundaries (list taps, phone switches).
 * A Hermes session is identified by its bridge id, a Herdr terminal by its
 * relay address — and the `kind` tag is what makes it a TYPE ERROR to pass a
 * Herdr id into a Hermes-only operation (sessions.switch, enterSession, …):
 * those functions take `string`, and an `{kind:"herdr", …}` object is not
 * assignable to `string`.
 */
export type AnySessionId =
  | { kind: "hermes"; id: string }
  | { kind: "herdr"; address: string };

/** Tagged constructor for the Herdr member of the union. */
export const herdrId = (address: string): AnySessionId => ({ kind: "herdr", address });

/** VALUE equality for tagged ids — every render rebuilds fresh id objects, so
 *  `===` would see "unchanged" lists as changed. */
export function sameSessionId(a: AnySessionId | null, b: AnySessionId | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind === "hermes") return b.kind === "hermes" && a.id === b.id;
  return b.kind === "herdr" && a.address === b.address;
}

/** Display state of a Herdr terminal row (mapped from the wire). */
export type HerdrRowState = "live" | "idle" | "finished";

/**
 * A Herdr terminal as a unified-list row. Hermes rows keep their `SessionItem`
 * shape untouched; this row type is what the list renders under the
 * `herdr · N` section header.
 */
export interface HerdrSessionRow {
  kind: "herdr";
  address: string;
  name: string;
  state: HerdrRowState;
  argv: string;
  cwd: string;
  /** Recency in SECONDS — the same unit `SessionItem.updated` uses. */
  updated: number;
  /** Exit code once finished (null while live/idle or unknown). */
  exitCode: number | null;
}

/**
 * Wire terminal of `herdr.list` / `herdr.read`. Every field but `address` is
 * optional at the boundary and defaulted in `toHerdrRow`: a partial relay
 * reply must degrade to a quiet row, never a thrown error.
 */
export interface HerdrTerminal {
  address: string;
  name?: string;
  argv?: string[] | string;
  cwd?: string;
  state?: string;
  exit_code?: number | null;
  created_ms?: number;
  finished_ms?: number | null;
}

/** Connection endpoint for the relay leg (profile section or env defaults). */
export interface HerdrEndpoint {
  url: string;
  token: string;
}

/** Status of the Herdr leg. "off" = feature not configured (pre-Phase-2). */
export type HerdrConnStatus = "off" | "connecting" | "connected" | "reconnecting" | "rejected";

/** The open read-only Herdr detail screen (`screen === "herdr-session"`). */
export interface HerdrDetail {
  address: string;
  name: string;
  state: HerdrRowState;
  exitCode: number | null;
  /** Plain text (ANSI-stripped) of the last `herdr.read`. */
  text: string;
}

/** The Herdr slice of AppState. Absent feature = empty rows + "off". */
export interface HerdrState {
  rows: HerdrSessionRow[];
  conn: HerdrConnStatus;
  detail: HerdrDetail | null;
}

const FINISHED_STATES = new Set(["finished", "done", "exited", "dead"]);
const LIVE_STATES = new Set(["live", "running"]);

function mapState(t: HerdrTerminal): HerdrRowState {
  if (t.finished_ms != null) return "finished";
  const raw = (t.state ?? "").toLowerCase();
  if (FINISHED_STATES.has(raw)) return "finished";
  if (LIVE_STATES.has(raw)) return "live";
  return "idle";
}

/** argv arrives as argv[] (or a flat string); the row carries one display string. */
function argvText(argv: HerdrTerminal["argv"]): string {
  if (Array.isArray(argv)) return argv.join(" ");
  return typeof argv === "string" ? argv : "";
}

export function toHerdrRow(t: HerdrTerminal): HerdrSessionRow {
  const created = typeof t.created_ms === "number" && Number.isFinite(t.created_ms)
    ? Math.floor(t.created_ms / 1000)
    : 0;
  return {
    kind: "herdr",
    address: t.address,
    name: (t.name ?? "").trim() || t.address,
    state: mapState(t),
    argv: argvText(t.argv),
    cwd: (t.cwd ?? "").trim(),
    updated: created,
    exitCode: typeof t.exit_code === "number" ? t.exit_code : null,
  };
}

/** Validate the terminals array of a herdr.list reply: malformed entries are
 *  silently dropped — the relay leg degrades, it never blocks the UI. */
export function herdrTerminalsFromListReply(raw: unknown): HerdrTerminal[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is HerdrTerminal => {
    if (!t || typeof t !== "object") return false;
    const address = (t as Record<string, unknown>).address;
    return typeof address === "string" && address.length >= 1 && address.length <= 128;
  });
}

/** Newest-first ordering, the Herdr twin of `orderedSessions` (stable on ties). */
export function orderedHerdrRows(rows: HerdrSessionRow[]): HerdrSessionRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (b.row.updated - a.row.updated) || (a.index - b.index))
    .map(({ row }) => row);
}

/**
 * Stable marker separating the Herdr world from Hermes rows. `⟐` (U+27D0) has
 * NO glyph in the firmware font (raw advW 0 — pinned in tests/glyphs.test.ts);
 * `◇` (U+25C7) renders. Never use emoji or unproven glyphs here.
 */
export const HERDR_MARKER = "◇";

/** Section header row of the Herdr block in the unified list. */
export const herdrSectionHeader = (count: number): string => `herdr · ${count}`;

/**
 * A Herdr list row: `◇ <age> <name> · <state>`. Shares the Hermes row budget
 * (64 chars / 63 bytes) via the same compose helper, so both worlds truncate
 * identically on the 576px display.
 */
export function formatHerdrRow(row: HerdrSessionRow, nowSeconds: number): string {
  const prefix = `${HERDR_MARKER} ${compactAge(row.updated, nowSeconds)} `;
  return composeListRow(prefix, `${row.name} · ${row.state}`);
}

/**
 * herdr.read serves the terminal byte stream; ANSI included. Phase 2 renders
 * PLAIN TEXT ONLY (observe/ANSI rendering is Phase 2.5), so escapes are
 * stripped at ingestion — the detail screen is plain by construction.
 */
const ANSI_PATTERN = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)?|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
