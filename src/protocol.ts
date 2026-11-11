export interface SessionItem {
  id: string;
  title: string;
  updated: number;
  tokens?: number;
  foreign?: boolean;
  read_only?: boolean;
  platform?: string;
}

export type HistoryItem =
  | { kind: "user"; text: string; id?: string; delivery?: "pending" | "delivered" | "uncertain" }
  | { kind: "tool"; name: string; label?: string; running: boolean; ok?: boolean }
  | { kind: "assistant"; text: string }
  | { kind: "banner"; text: string };

/** One selectable answer of a `prompt.request` (§C: id/label/style rules). */
export interface PromptOption {
  id: string;
  label: string;
  style: "primary" | "danger" | "";
  default?: boolean;
}

export type ServerMsg =
  | { t: "hello.ok"; caps: Record<string, unknown>; active: string | null }
  | { t: "sessions"; items: SessionItem[]; active: string | null }
  | { t: "active"; id: string }
  | { t: "history"; id: string; items: HistoryItem[]; ok?: boolean }
  | { t: "transcript"; text: string }
  | { t: "assistant"; text: string }
  | { t: "assistant.delta"; text: string }
  | { t: "tool.start"; name: string; label?: string; emoji?: string }
  | { t: "tool.end"; name: string; ok: boolean }
  | { t: "turn.done" }
  | { t: "notice"; text: string }
  | { t: "ack"; id: string; ok: boolean; error?: string }
  | {
      t: "prompt.request";
      id: string;
      kind: string;
      title: string;
      command: string;
      description: string;
      options: PromptOption[];
      timeout_s: number;
      timeout_choice: string | null;
    }
  | { t: "prompt.resolved"; id: string; choice: string; by: "user" | "timeout" | "other" }
  | { t: "error"; msg: string };

const SERVER_TYPES = new Set([
  "hello.ok",
  "sessions",
  "active",
  "history",
  "transcript",
  "assistant",
  "assistant.delta",
  "tool.start",
  "tool.end",
  "turn.done",
  "notice",
  "ack",
  "prompt.request",
  "prompt.resolved",
  "error",
]);

export const hello = (token: string, device: string) =>
  JSON.stringify({ t: "hello", token, device });

export const sessionsList = () => JSON.stringify({ t: "sessions.list" });

export const sessionsSwitch = (id: string) =>
  JSON.stringify({ t: "sessions.switch", id });

export const sessionsNew = (title?: string) =>
  JSON.stringify({ t: "sessions.new", title });

export const textMsg = (text: string, id?: string) =>
  JSON.stringify(id ? { t: "text", text, id } : { t: "text", text });

export const stopMsg = () => JSON.stringify({ t: "stop" });

/** The wearer's answer to a prompt (§C client → server). */
export const promptResponse = (id: string, choice: string) =>
  JSON.stringify({ t: "prompt.response", id, choice });

export const audioStart = () => JSON.stringify({ t: "audio.start" });
export const audioStop = () => JSON.stringify({ t: "audio.stop" });

// §C option id: ^[a-z0-9_-]{1,32}$, and "none" is forbidden.
const OPTION_ID = /^[a-z0-9_-]{1,32}$/;
const PROMPT_KINDS = new Set(["exec_approval"]); // clarify/slash_confirm are reserved (phase 2)

const isId = (v: unknown, max = 128): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max;

/** §C field rules for `prompt.request` — both sides validate; a bad shape is
 *  rejected and the frame dropped (A13). */
function validatePromptRequest(m: Record<string, unknown>): void {
  if (!isId(m.id)) throw new Error("bad prompt.request: id");
  if (typeof m.kind !== "string" || !PROMPT_KINDS.has(m.kind))
    throw new Error(`bad prompt.request: kind ${String(m.kind)}`);
  if (typeof m.title !== "string" || m.title.length > 24)
    throw new Error("bad prompt.request: title");
  if (typeof m.command !== "string" || typeof m.description !== "string")
    throw new Error("bad prompt.request: command/description");
  const options = m.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 6)
    throw new Error("bad prompt.request: options count");
  const ids = new Set<string>();
  let defaults = 0;
  for (const o of options) {
    if (!o || typeof o !== "object") throw new Error("bad prompt.request: option");
    const opt = o as Record<string, unknown>;
    if (typeof opt.id !== "string" || !OPTION_ID.test(opt.id) || opt.id === "none")
      throw new Error("bad prompt.request: option id");
    if (ids.has(opt.id)) throw new Error("bad prompt.request: duplicate option id");
    ids.add(opt.id);
    if (typeof opt.label !== "string" || opt.label.length < 1 || opt.label.length > 24)
      throw new Error("bad prompt.request: option label");
    if (opt.style !== "primary" && opt.style !== "danger" && opt.style !== "")
      throw new Error("bad prompt.request: option style");
    if (opt.default === true) defaults++;
  }
  if (defaults !== 1) throw new Error("bad prompt.request: exactly one default required");
  const timeoutS = m.timeout_s;
  if (typeof timeoutS !== "number" || !Number.isInteger(timeoutS) || timeoutS < 0)
    throw new Error("bad prompt.request: timeout_s");
  if (timeoutS > 0) {
    if (typeof m.timeout_choice !== "string" || !ids.has(m.timeout_choice))
      throw new Error("bad prompt.request: timeout_choice");
  } else if (m.timeout_choice != null) {
    throw new Error("bad prompt.request: timeout_s 0 ⇒ timeout_choice null");
  }
}

function validatePromptResolved(m: Record<string, unknown>): void {
  if (!isId(m.id)) throw new Error("bad prompt.resolved: id");
  if (typeof m.choice !== "string" || (m.choice !== "none" && !OPTION_ID.test(m.choice)))
    throw new Error("bad prompt.resolved: choice");
  if (m.by !== "user" && m.by !== "timeout" && m.by !== "other")
    throw new Error("bad prompt.resolved: by");
}

export function parseServer(raw: string): ServerMsg {
  const m = JSON.parse(raw);
  if (!m || typeof m.t !== "string" || !SERVER_TYPES.has(m.t))
    throw new Error(`bad server msg: ${raw}`);
  if (m.t === "prompt.request") validatePromptRequest(m);
  else if (m.t === "prompt.resolved") validatePromptResolved(m);
  return m as ServerMsg;
}
