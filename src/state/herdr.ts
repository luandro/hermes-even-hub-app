import type { AppState } from "./store";
import {
  orderedHerdrRows,
  stripAnsi,
  toHerdrRow,
  type HerdrConnStatus,
  type HerdrDetail,
  type HerdrSessionRow,
  type HerdrTerminal,
} from "../herdr/model";

/**
 * Pure state transitions for the Herdr leg. None of these touch the Hermes
 * session list, the active id, or the history/stream state — a Herdr frame can
 * never move a Hermes conversation. Failures are silent by design (no notices,
 * no toasts): the list degrades to Hermes-only.
 */

/** Replace the Herdr rows from a herdr.list reply (already validated). */
export function applyHerdrTerminals(s: AppState, terminals: HerdrTerminal[]): AppState {
  const rows = orderedHerdrRows(terminals.map(toHerdrRow));
  return { ...s, herdr: { ...s.herdr, rows, detail: refreshDetail(s.herdr.detail, rows) } };
}

/** Keep the open detail screen's live fields in step with its terminal. */
function refreshDetail(detail: HerdrDetail | null, rows: HerdrSessionRow[]): HerdrDetail | null {
  if (!detail) return null;
  const row = rows.find((r) => r.address === detail.address);
  // Terminal gone from the relay: keep the last read on screen — it is still
  // the text the wearer was reading, and herdr serves finished reads anyway.
  if (!row) return detail;
  if (row.name === detail.name && row.state === detail.state && row.exitCode === detail.exitCode) {
    return detail;
  }
  return { ...detail, name: row.name, state: row.state, exitCode: row.exitCode };
}

/**
 * Socket status for the relay leg. Any non-connected status silently drops the
 * rows (Hermes-only degradation) but keeps an open detail screen readable.
 */
export function setHerdrConn(s: AppState, status: HerdrConnStatus): AppState {
  if (s.herdr.conn === status && (status === "connected" || s.herdr.rows.length === 0)) return s;
  return {
    ...s,
    herdr: {
      ...s.herdr,
      conn: status,
      rows: status === "connected" ? s.herdr.rows : [],
    },
  };
}

/** Tap on a Herdr row: open the read-only detail screen. Unknown → no-op. */
export function openHerdrSession(s: AppState, address: string): AppState {
  const row = s.herdr.rows.find((r) => r.address === address);
  if (!row) return s;
  return {
    ...s,
    screen: "herdr-session",
    herdr: {
      ...s.herdr,
      detail: { address, name: row.name, state: row.state, exitCode: row.exitCode, text: "" },
    },
  };
}

/** A herdr.read reply for the open terminal (ANSI stripped at the boundary). */
export function setHerdrRead(s: AppState, address: string, text: string): AppState {
  const d = s.herdr.detail;
  if (!d || d.address !== address) return s;
  const plain = stripAnsi(text);
  if (plain === d.text) return s;
  return { ...s, herdr: { ...s.herdr, detail: { ...d, text: plain } } };
}

/** Back gesture: return to the unified list, drop the detail. */
export function closeHerdrSession(s: AppState): AppState {
  return { ...s, screen: "list", herdr: { ...s.herdr, detail: null } };
}
