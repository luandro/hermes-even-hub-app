import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HerdrClient, HERDR_LIST_POLL_MS } from "../src/net/herdr-ws";

const profile = { url: "ws://relay.lan:8787", token: "herdr-tok" };

class FakeWS {
  static last: FakeWS | undefined;
  static opened: FakeWS[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: unknown }) => void;
  onclose?: (event?: { code?: number; reason?: string }) => void;
  onerror?: () => void;
  sent: unknown[] = [];
  readyState = 1;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWS.last = this;
    FakeWS.opened.push(this);
  }

  send(d: unknown): void { this.sent.push(d); }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Reply to the i-th sent request (0-based). */
  replyTo(i: number, payload: Record<string, unknown>): void {
    const req = JSON.parse(String(this.sent[i])) as { id?: number };
    this.onmessage?.({ data: JSON.stringify({ id: req.id, ...payload }) });
  }

  raw(data: unknown): void { this.onmessage?.({ data }); }
}

const sent = (ws: FakeWS, i: number) => JSON.parse(String(ws.sent[i])) as Record<string, unknown>;

/** Inbound frames route through an async decode — flush the microtask chain. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  FakeWS.last = undefined;
  FakeWS.opened = [];
});

describe("HerdrClient: feature off", () => {
  it("connect(null) opens NO socket and only reports off", () => {
    const statuses: string[] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onStatus: (s) => statuses.push(s), onTerminals: () => {} });
    c.connect(null);
    expect(FakeWS.opened).toEqual([]);
    expect(statuses).toEqual(["off"]);
  });
});

describe("HerdrClient: hello → list → rows", () => {
  it("carries the token on the URL (browsers cannot set Authorization headers), sends hello, then herdr.list", async () => {
    const lists: unknown[][] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: (t) => lists.push(t) });
    c.connect(profile);
    expect(FakeWS.last!.url).toContain("ws://relay.lan:8787");
    expect(FakeWS.last!.url).toContain("token=herdr-tok");

    FakeWS.last!.onopen!();
    expect(sent(FakeWS.last!, 0).method).toBe("hello");

    await flush();
    FakeWS.last!.replyTo(0, { ok: true, relay: "herdr-relay", herdr: { generation: 1, version: "1.0" } });
    await flush();
    expect(sent(FakeWS.last!, 1).method).toBe("herdr.list");

    FakeWS.last!.replyTo(1, { terminals: [{ address: "t7", name: "build" }] });
    await flush();
    expect(lists).toEqual([[{ address: "t7", name: "build" }]]);
  });

  it("polls herdr.list every 15s while connected", async () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    await flush();
    FakeWS.last!.replyTo(0, { ok: true });
    await flush();
    FakeWS.last!.replyTo(1, { terminals: [] });
    await flush();
    const listsBefore = FakeWS.last!.sent.filter((s) => String(s).includes("herdr.list")).length;

    vi.advanceTimersByTime(HERDR_LIST_POLL_MS);
    vi.advanceTimersByTime(HERDR_LIST_POLL_MS);
    const listsAfter = FakeWS.last!.sent.filter((s) => String(s).includes("herdr.list")).length;

    expect(listsAfter - listsBefore).toBe(2);
    vi.useRealTimers();
  });

  it("stops polling after disconnect", async () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    FakeWS.last!.replyTo(0, { ok: true });
    await flush();
    c.disconnect();
    const after = FakeWS.last!.sent.length;
    vi.advanceTimersByTime(HERDR_LIST_POLL_MS * 3);
    expect(FakeWS.last!.sent.length).toBe(after);
    vi.useRealTimers();
  });
});

describe("HerdrClient: herdr.read", () => {
  it("sends herdr.read with terminal+lines and routes the reply by echoed id", async () => {
    const reads: { address: string; text: string; complete: boolean }[] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {}, onRead: (r) => reads.push(r) });
    c.connect(profile);
    FakeWS.last!.onopen!();
    await flush();
    FakeWS.last!.replyTo(0, { ok: true });
    await flush();
    FakeWS.last!.replyTo(1, { terminals: [] });
    await flush();

    c.read("t7", 50);
    const req = FakeWS.last!.sent.map((s) => JSON.parse(String(s))).find((r) => r.method === "herdr.read");
    expect(req).toMatchObject({ params: { terminal: "t7", lines: 50 } });

    FakeWS.last!.replyTo(FakeWS.last!.sent.indexOf(JSON.stringify(req)), {
      terminal: "t7", text: "out", complete: true,
    });
    await flush();
    expect(reads).toEqual([{ address: "t7", text: "out", complete: true }]);
  });

  it("correlates out-of-order replies by id", async () => {
    const reads: string[] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {}, onRead: (r) => reads.push(r.text) });
    c.connect(profile);
    FakeWS.last!.onopen!();
    c.list(); // id for list
    c.read("t1", 10); // later id
    const readReq = FakeWS.last!.sent.map((s) => JSON.parse(String(s))).find((r) => r.method === "herdr.read");
    // Answer the read FIRST even though the list request is older.
    FakeWS.last!.replyTo(FakeWS.last!.sent.indexOf(JSON.stringify(readReq)), { terminal: "t1", text: "zzz", complete: true });
    await flush();
    expect(reads).toEqual(["zzz"]);
  });
});

describe("HerdrClient: failure behavior (silent degradation)", () => {
  it("reconnects with backoff after an abnormal close", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onStatus: (s) => statuses.push(s), onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    FakeWS.last!.close(1006, "abnormal closure");

    expect(statuses).toContain("reconnecting");
    vi.advanceTimersByTime(500);
    expect(FakeWS.opened).toHaveLength(2);
    vi.useRealTimers();
  });

  it("grows the backoff delay and caps it", () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    FakeWS.last!.close(1006); // first failure: 500ms delay, then doubles to 1000
    vi.advanceTimersByTime(500);
    expect(FakeWS.opened).toHaveLength(2);
    // Socket #2 closes BEFORE its hello completes, so the delay is not reset.
    FakeWS.last!.close(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWS.opened).toHaveLength(2); // not yet — backoff doubled to 1000
    vi.advanceTimersByTime(1);
    expect(FakeWS.opened).toHaveLength(3);
    vi.useRealTimers();
  });

  it("stops reconnecting after disconnect()", () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    c.disconnect();
    const opened = FakeWS.opened.length;
    vi.advanceTimersByTime(30_000);
    expect(FakeWS.opened).toHaveLength(opened);
    vi.useRealTimers();
  });

  it("a rejected hello (ok:false) does not reconnect-storm", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onStatus: (s) => statuses.push(s), onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    FakeWS.last!.replyTo(0, { ok: false, error: "bad token" });
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.opened).toHaveLength(1);
    expect(statuses).toContain("rejected");
    vi.useRealTimers();
  });

  it("ignores malformed and unsolicited frames without throwing", () => {
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    expect(() => FakeWS.last!.raw("not json")).not.toThrow();
    expect(() => FakeWS.last!.raw({ event: "paint", terminal: "t7", bytes_base64: "AAA" })).not.toThrow();
    expect(() => FakeWS.last!.raw({ id: 999, error: { code: -32601, data: { rejected_by: "allowlist" } } })).not.toThrow();
  });

  it("relays no terminals when the socket dies mid-flight", () => {
    const c = new HerdrClient({ WS: FakeWS as any, onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    FakeWS.last!.close(1006);
    // never opened ⇒ never listed ⇒ main degrades to the Hermes-only list
    expect(FakeWS.last!.sent.filter((s) => String(s).includes("herdr.list"))).toEqual([]);
  });
});

describe("HerdrClient lifecycle hooks", () => {
  afterEach(() => vi.useRealTimers());

  it("surfaces connecting → connected statuses", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const c = new HerdrClient({ WS: FakeWS as any, onStatus: (s) => statuses.push(s), onTerminals: () => {} });
    c.connect(profile);
    FakeWS.last!.onopen!();
    expect(statuses[0]).toBe("connecting");
    expect(statuses).toContain("connected");
  });
});
