import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { BridgeClient } from "../net/ws-client";
import { audioStart, audioStop } from "../protocol";

export interface AudioCapture {
  /** true when the mic is on */
  readonly recording: boolean;
  /** Start capture: send audio.start frame then audioControl(true) */
  start(): Promise<void>;
  /** Stop capture: audioControl(false) then send audio.stop frame */
  stop(): Promise<void>;
  /** Call on every onEvenHubEvent — forwards PCM if recording */
  handleEvent(event: any): void;
}

export type CaptureErrorHandler = (err: unknown) => void;

let micStopPendingCleanup = false;

export function resetCaptureState(): void {
  micStopPendingCleanup = false;
}

export function createCapture(
  bridge: EvenAppBridge,
  client: BridgeClient,
  onError?: CaptureErrorHandler,
): AudioCapture {
  let recording = false;
  return {
    get recording() { return recording; },
    async start() {
      if (recording) return;
      if (micStopPendingCleanup) {
        try {
          await bridge.audioControl(false);
        } catch {
          // best-effort cleanup
        }
        micStopPendingCleanup = false;
      }
      recording = true;
      client.send(audioStart());
      try {
        await bridge.audioControl(true);
      } catch (err) {
        recording = false;
        client.send(audioStop());
        console.error("[capture] failed to start mic", err);
        onError?.(err);
        throw err;
      }
    },
    async stop() {
      if (!recording) return;
      recording = false;
      try {
        try {
          await bridge.audioControl(false);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await bridge.audioControl(false);
        }
      } catch (err) {
        micStopPendingCleanup = true;
        console.error("[capture] failed to stop mic", err);
        onError?.(err);
        throw err;
      } finally {
        client.send(audioStop());
      }
    },
    handleEvent(event: any) {
      if (!recording) return;
      const pcm = event?.audioEvent?.audioPcm;
      if (pcm instanceof Uint8Array && pcm.length > 0) {
        client.sendBinary(pcm);
      }
    },
  };
}
