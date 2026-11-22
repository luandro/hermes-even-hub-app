import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { AppState } from "../state/store";
import { connDot } from "../state/store";
import { HERDR_MARKER } from "../herdr/model";
import { IDS, setText } from "./render";
import { truncateTitle } from "./session-list";
import { THREAD_VIEWPORT_LINES, clampToBudget, wrapTextLines } from "./stream";

/**
 * The Herdr detail screen (`herdr-session`) — a SEPARATE screen kind from the
 * Hermes session screen. It is read-only by construction: the view is a pure
 * text projection (header / body / status), and no gesture on this screen maps
 * to a mic, a send, or any wire frame. There is no input path to build until
 * the input phase exists.
 */

export const HERDR_READING = "reading…";
export const HERDR_READONLY = "read-only";

/** Pure projection of the open Herdr detail screen (unit-tested directly). */
export function herdrSessionView(s: AppState): { header: string; body: string; status: string } {
  const d = s.herdr.detail;
  if (!d) return { header: `${HERDR_MARKER} herdr`, body: "", status: HERDR_READONLY };
  return {
    header: truncateTitle(`${HERDR_MARKER} ${d.name} · ${d.state}`),
    body: d.text ? tailLines(d.text) : HERDR_READING,
    status: d.state === "finished"
      ? `${HERDR_READONLY} · exit ${d.exitCode ?? "?"}`
      : HERDR_READONLY,
  };
}

/** Last viewport of the wrapped plain text, inside the SDK byte budget. */
function tailLines(text: string): string {
  const lines = wrapTextLines(text);
  return clampToBudget(lines.slice(-THREAD_VIEWPORT_LINES));
}

/** Render the herdr-session page onto the 4-container chat layout. */
export async function renderHerdrSession(bridge: EvenAppBridge, s: AppState): Promise<void> {
  const view = herdrSessionView(s);
  await setText(bridge, IDS.header, view.header);
  // The dot mirrors the RELAY socket this screen depends on, not the bridge.
  await setText(bridge, IDS.dot, connDot(s.herdr.conn));
  await setText(bridge, IDS.body, view.body);
  await setText(bridge, IDS.status, view.status);
}
