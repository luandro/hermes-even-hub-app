import { describe, it, expect } from "vitest";
import { hello, parseServer, audioStart, audioStop, promptResponse } from "../src/protocol";

describe("protocol", () => {
  it("builds a hello frame", () => {
    expect(JSON.parse(hello("tok", "g2"))).toEqual({ t: "hello", token: "tok", device: "g2" });
  });
  it("parses an assistant frame", () => {
    const msg = parseServer(JSON.stringify({ t: "assistant", text: "hi" }));
    expect(msg).toEqual({ t: "assistant", text: "hi" });
  });
  it("parses a history frame", () => {
    const items = [{ kind: "user", text: "old question" }, { kind: "assistant", text: "old answer" }];
    const msg = parseServer(JSON.stringify({ t: "history", id: "s1", items, ok: true }));
    expect(msg).toEqual({ t: "history", id: "s1", items, ok: true });
  });
  it("rejects unknown types", () => {
    expect(() => parseServer(JSON.stringify({ t: "nope" }))).toThrow();
  });
  it("builds audio control frames", () => {
    expect(JSON.parse(audioStart())).toEqual({ t: "audio.start" });
    expect(JSON.parse(audioStop())).toEqual({ t: "audio.stop" });
  });
  it("parses sessions frame containing foreign and read_only telegram sessions", () => {
    const raw = JSON.stringify({
      t: "sessions",
      active: null,
      items: [
        {
          id: "tg-1",
          title: "🔒 Telegram Session",
          updated: 1780000000,
          foreign: true,
          read_only: true,
          platform: "telegram",
        },
      ],
    });
    const parsed = parseServer(raw);
    expect(parsed).toEqual({
      t: "sessions",
      active: null,
      items: [
        {
          id: "tg-1",
          title: "🔒 Telegram Session",
          updated: 1780000000,
          foreign: true,
          read_only: true,
          platform: "telegram",
        },
      ],
    });
  });
  it("parses a notice frame", () => {
    const raw = JSON.stringify({ t: "notice", text: "Some replies were lost while the glasses were offline." });
    const parsed = parseServer(raw);
    expect(parsed).toEqual({ t: "notice", text: "Some replies were lost while the glasses were offline." });
  });
  it("parses a mirror frame with the optional cid pairing signal (V3.1 W3)", () => {
    const raw = JSON.stringify({
      t: "mirror", id: "g2-1", from: "telegram", turn_id: "t1",
      user: "hi", assistant: "ok", cid: "conv-1",
    });
    const parsed = parseServer(raw);
    expect(parsed.t).toBe("mirror");
    if (parsed.t === "mirror") expect(parsed.cid).toBe("conv-1");
  });
  it("parses a mirror frame without cid (older bridges omit the field)", () => {
    const raw = JSON.stringify({
      t: "mirror", id: "g2-1", from: "telegram", turn_id: "t1",
      user: "hi", assistant: "ok",
    });
    const parsed = parseServer(raw);
    expect(parsed.t).toBe("mirror");
    if (parsed.t === "mirror") expect(parsed.cid).toBeUndefined();
  });
  it("builds a text frame with optional id", async () => {
    const { textMsg } = await import("../src/protocol");
    expect(JSON.parse(textMsg("hello"))).toEqual({ t: "text", text: "hello" });
    expect(JSON.parse(textMsg("hello", "tx-123"))).toEqual({ t: "text", text: "hello", id: "tx-123" });
  });
  it("parses a valid prompt.request frame (default not first, timeout 0 ⇒ null)", () => {
    const raw = JSON.stringify({
      t: "prompt.request",
      id: "req-1",
      kind: "exec_approval",
      title: "Approve?",
      command: "rm -rf /tmp/x",
      description: "shell",
      options: [
        { id: "once", label: "Approve once", style: "primary" },
        { id: "deny", label: "Deny", style: "danger", default: true },
      ],
      timeout_s: 0,
      timeout_choice: null,
    });
    const msg = parseServer(raw);
    expect(msg).toEqual({
      t: "prompt.request",
      id: "req-1",
      kind: "exec_approval",
      title: "Approve?",
      command: "rm -rf /tmp/x",
      description: "shell",
      options: [
        { id: "once", label: "Approve once", style: "primary" },
        { id: "deny", label: "Deny", style: "danger", default: true },
      ],
      timeout_s: 0,
      timeout_choice: null,
    });
  });
  it("parses prompt.resolved frames including none/other", () => {
    expect(parseServer(JSON.stringify({ t: "prompt.resolved", id: "r1", choice: "deny", by: "user" })))
      .toEqual({ t: "prompt.resolved", id: "r1", choice: "deny", by: "user" });
    expect(parseServer(JSON.stringify({ t: "prompt.resolved", id: "r1", choice: "none", by: "other" })))
      .toEqual({ t: "prompt.resolved", id: "r1", choice: "none", by: "other" });
    expect(parseServer(JSON.stringify({ t: "prompt.resolved", id: "r1", choice: "once", by: "timeout" })))
      .toEqual({ t: "prompt.resolved", id: "r1", choice: "once", by: "timeout" });
  });
  it("rejects A13/§C bad prompt.request shapes at parse", () => {
    const valid = {
      t: "prompt.request",
      id: "req-1",
      kind: "exec_approval",
      title: "Approve?",
      command: "rm -rf /tmp/x",
      description: "shell",
      options: [
        { id: "once", label: "Approve once", style: "primary" },
        { id: "deny", label: "Deny", style: "danger", default: true },
      ],
      timeout_s: 0,
      timeout_choice: null,
    };
    const bad: unknown[] = [
      { ...valid, kind: "clarify" },                      // unknown kind (phase 2 reserved)
      { ...valid, options: [valid.options[1]] },          // < 2 options
      { ...valid, options: [...Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `o${i}`, style: "", ...(i === 0 ? { default: true } : {}) }))] }, // > 6 options
      { ...valid, options: [{ id: "deny", label: "Deny", style: "danger", default: true }, { id: "deny", label: "Deny2", style: "" }] }, // duplicate id
      { ...valid, options: [valid.options[0], { ...valid.options[1], default: false }] }, // default count 0
      { ...valid, options: [...valid.options, { ...valid.options[0], id: "x", default: true }] }, // default count 2
      { ...valid, timeout_s: 15, timeout_choice: "nope" }, // timeout_choice not an option id
      { ...valid, timeout_s: 15, timeout_choice: null },   // timeout_s > 0 needs a choice
      { ...valid, timeout_s: 0, timeout_choice: "once" },  // timeout_s 0 ⇒ choice null
      { ...valid, id: "" },                                // id not 1–128
      { ...valid, id: "x".repeat(129) },
      { ...valid, title: "t".repeat(25) },                 // title ≤ 24
      { ...valid, options: [{ id: "none", label: "None", style: "", default: true }, valid.options[0]] }, // "none" forbidden
      { ...valid, options: [{ id: "Bad Id", label: "x", style: "", default: true }, valid.options[0]] }, // id pattern
      { ...valid, options: [{ id: "a", label: "", style: "", default: true }, valid.options[0]] }, // label 1–24
      { ...valid, options: [{ id: "a", label: "x".repeat(25), style: "", default: true }, valid.options[0]] },
      { ...valid, options: [{ id: "a", label: "x", style: "wild", default: true }, valid.options[0]] }, // style enum
      { ...valid, timeout_s: -1 },
      { ...valid, timeout_s: 1.5 },                        // integer ≥ 0
    ];
    for (const frame of bad) {
      expect(() => parseServer(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
  });
  it("rejects bad prompt.resolved shapes at parse", () => {
    const bad = [
      { t: "prompt.resolved", id: "", choice: "deny", by: "user" },
      { t: "prompt.resolved", id: "r", choice: "Deny", by: "user" },   // uppercase ≠ option pattern
      { t: "prompt.resolved", id: "r", choice: "", by: "other" },
      { t: "prompt.resolved", id: "r", choice: "deny", by: "agent" },  // by enum
    ];
    for (const frame of bad) {
      expect(() => parseServer(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
  });
  it("builds a prompt.response frame", () => {
    expect(JSON.parse(promptResponse("req-1", "deny")))
      .toEqual({ t: "prompt.response", id: "req-1", choice: "deny" });
  });
  it("parses a mirror frame (V3 TG2G, frozen contract)", () => {
    const raw = JSON.stringify({
      t: "mirror",
      id: "g2-leg-1",
      from: "telegram",
      turn_id: "turn-42",
      user: "what's the weather",
      assistant: "Sunny, 22C.",
    });
    expect(parseServer(raw)).toEqual({
      t: "mirror",
      id: "g2-leg-1",
      from: "telegram",
      turn_id: "turn-42",
      user: "what's the weather",
      assistant: "Sunny, 22C.",
    });
  });
  it("rejects bad mirror shapes at parse", () => {
    const valid = {
      t: "mirror",
      id: "g2-leg-1",
      from: "telegram",
      turn_id: "turn-42",
      user: "u",
      assistant: "a",
    };
    const bad: unknown[] = [
      { t: "mirror" },            // missing fields
      { ...valid, id: 7 },        // id not a string
      { ...valid, id: "" },       // id empty
      { ...valid, from: 1 },
      { ...valid, turn_id: {} },
      { ...valid, user: null },
      { ...valid, assistant: 3 },
    ];
    for (const frame of bad) {
      expect(() => parseServer(JSON.stringify(frame)), JSON.stringify(frame)).toThrow();
    }
  });
  it("parses an ack frame", () => {
    const rawOk = JSON.stringify({ t: "ack", id: "msg-1", ok: true });
    expect(parseServer(rawOk)).toEqual({ t: "ack", id: "msg-1", ok: true });
    const rawErr = JSON.stringify({ t: "ack", id: "msg-2", ok: false, error: "turn failed" });
    expect(parseServer(rawErr)).toEqual({ t: "ack", id: "msg-2", ok: false, error: "turn failed" });
  });
});
