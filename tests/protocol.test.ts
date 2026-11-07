import { describe, it, expect } from "vitest";
import { hello, parseServer, audioStart, audioStop } from "../src/protocol";

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
  it("builds a text frame with optional id", async () => {
    const { textMsg } = await import("../src/protocol");
    expect(JSON.parse(textMsg("hello"))).toEqual({ t: "text", text: "hello" });
    expect(JSON.parse(textMsg("hello", "tx-123"))).toEqual({ t: "text", text: "hello", id: "tx-123" });
  });
  it("parses an ack frame", () => {
    const rawOk = JSON.stringify({ t: "ack", id: "msg-1", ok: true });
    expect(parseServer(rawOk)).toEqual({ t: "ack", id: "msg-1", ok: true });
    const rawErr = JSON.stringify({ t: "ack", id: "msg-2", ok: false, error: "turn failed" });
    expect(parseServer(rawErr)).toEqual({ t: "ack", id: "msg-2", ok: false, error: "turn failed" });
  });
});
