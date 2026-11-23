import { decodeWebSocketData } from "./ws-client";
import type { HerdrConnStatus, HerdrEndpoint } from "../herdr/model";

/**
 * The Herdr relay leg — a SEPARATE WebSocket client, independent of the Hermes
 * bridge socket. The relay speaks allowlisted JSON-RPC: `{method, params}`
 * requests with an optional `id` echoed on the reply. Phase 2 uses read-only
 * methods (`hello`, `herdr.list`, `herdr.read`); there is no `herdr.input`
 * call here and no write path may be added before its phase.
 *
 * Auth: the relay contract is `Authorization: Bearer <token>`, but a browser
 * WebSocket cannot set request headers, so the token rides the URL query
 * (`?token=…`) — same plaintext exposure class as the ws:// bridge itself.
 */

export const HERDR_LIST_POLL_MS = 15_000;
export const HERDR_READ_LINES = 50;

interface HerdrDeps {
  WS?: typeof WebSocket;
  onStatus?: (s: HerdrConnStatus) => void;
  /** Raw `terminals` array of every herdr.list reply (validated upstream). */
  onTerminals: (terminals: unknown[]) => void;
  onRead?: (r: { address: string; text: string; complete: boolean }) => void;
}

type Reply = Record<string, unknown>;

function urlWithToken(endpoint: HerdrEndpoint): string {
  const sep = endpoint.url.includes("?") ? "&" : "?";
  return `${endpoint.url}${sep}token=${encodeURIComponent(endpoint.token)}`;
}

export class HerdrClient {
  private readonly d: HerdrDeps;
  private ws?: WebSocket;
  private endpoint?: HerdrEndpoint;
  private alive = false;
  private delay = 500;
  private nextId = 1;
  /** True once ANY socket on this endpoint reached onopen (reset per connect). */
  private everConnected = false;
  /** Consecutive closed-without-ever-opening strikes (reset by any open). */
  private failedOpens = 0;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(d: HerdrDeps) {
    this.d = d;
  }

  /** null endpoint = feature OFF: no socket, no timers, no rows — ever. */
  connect(endpoint: HerdrEndpoint | null): void {
    this.stop();
    if (!endpoint) {
      this.d.onStatus?.("off");
      return;
    }
    this.endpoint = endpoint;
    this.alive = true;
    this.delay = 500;
    this.everConnected = false;
    this.failedOpens = 0;
    this.open();
  }

  disconnect(): void {
    this.stop();
    this.d.onStatus?.("off");
  }

  /** Fire a herdr.list now (used by the 15s poll and on hello). */
  list(): void {
    void this.request("herdr.list", {}).then((reply) => {
      if (Array.isArray(reply.terminals)) this.d.onTerminals(reply.terminals);
    });
  }

  /** Fire a herdr.read for one terminal (read-only detail screen). */
  read(address: string, lines = HERDR_READ_LINES): void {
    void this.request("herdr.read", { terminal: address, lines }).then((reply) => {
      this.d.onRead?.({
        address: typeof reply.terminal === "string" ? reply.terminal : address,
        text: typeof reply.text === "string" ? reply.text : "",
        complete: reply.complete === true,
      });
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Reply> {
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (ws && (ws as unknown as { readyState: number }).readyState === 1) {
        (ws as unknown as { send: (d: string) => void }).send(JSON.stringify({ id, method, params }));
      }
      // A dead socket leaves the promise pending; close() clears the map.
    });
  }

  private open(): void {
    if (!this.endpoint) return;
    const WS = this.d.WS ?? WebSocket;
    this.d.onStatus?.("connecting");
    const ws = new WS(urlWithToken(this.endpoint));
    this.ws = ws as unknown as WebSocket;

    (ws as unknown as { onopen: () => void }).onopen = () => {
      this.everConnected = true;
      this.failedOpens = 0;
      this.delay = 500;
      this.d.onStatus?.("connected");
      void this.request("hello", {}).then((reply) => {
        if (reply.ok === true) {
          this.list();
          this.startPoll();
        } else {
          // Bad token / rejected hello: stop for good — a reconnect storm
          // against a rejecting relay is a toast storm in disguise.
          this.alive = false;
          this.d.onStatus?.("rejected");
          (ws as unknown as { close: () => void }).close();
        }
      });
    };

    (ws as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage = (e) => {
      void decodeWebSocketData(e.data)
        .then((raw) => this.handleFrame(raw))
        .catch((err) => console.warn("[herdr] ignored malformed frame", err));
    };

    (ws as unknown as { onclose: () => void }).onclose = () => {
      this.clearTimers();
      this.pending.clear();
      if (this.ws === ws) this.ws = undefined;
      if (!this.alive) return;
      // HEURISTIC — the WS API hides the HTTP status of a failed upgrade, so a
      // relay answering 401 (bad token) at the handshake is indistinguishable
      // from a network failure here: both fire onerror+onclose with no onopen.
      // Practical rule: count consecutive closes with ZERO successful opens on
      // this endpoint; 3 strikes → auth-rejected, terminal (same semantics as
      // the "rejected" path above — no reconnect storm against a rejecting
      // relay). Any successful open resets the count, so a plain outage that
      // later recovers never trips it.
      if (!this.everConnected) {
        this.failedOpens++;
        if (this.failedOpens >= 3) {
          this.alive = false;
          this.d.onStatus?.("auth-rejected");
          return;
        }
      }
      // Silent degradation: rows are dropped by the state layer, no notices.
      this.d.onStatus?.("reconnecting");
      this.reconnectTimer = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, 8000);
    };

    (ws as unknown as { onerror: () => void }).onerror = () => {
      (ws as unknown as { close: () => void }).close();
    };
  }

  private handleFrame(raw: string): void {
    const msg: unknown = JSON.parse(raw);
    if (!msg || typeof msg !== "object") return;
    const id = (msg as Record<string, unknown>).id;
    if (typeof id !== "number") return; // unsolicited (paint frames, pushes)
    const resolve = this.pending.get(id);
    if (!resolve) return; // unknown/duplicate id — ignore silently
    this.pending.delete(id);
    resolve(msg as Reply);
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.list(), HERDR_LIST_POLL_MS);
  }

  private clearTimers(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.reconnectTimer);
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
  }

  /** Full stop: timers, socket, pending requests. Emits nothing. */
  private stop(): void {
    this.alive = false;
    this.clearTimers();
    this.pending.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws as unknown as { readyState: number }).readyState !== 3) {
      (ws as unknown as { close: () => void }).close();
    }
  }
}
