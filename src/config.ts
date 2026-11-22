import type { ConnectionProfile } from "./storage/persist";
import type { HerdrEndpoint } from "./herdr/model";

export interface BridgeDefaults {
  url: string;
  token: string;
}

export function loadBridgeDefaults(): BridgeDefaults {
  return {
    url: import.meta.env.VITE_BRIDGE_URL
      ?? import.meta.env.VITE_BRIDGE_LAN_URL
      ?? import.meta.env.VITE_BRIDGE_REMOTE_URL
      ?? "",
    token: "",
  };
}

/** Env-side Herdr relay defaults (VITE_HERDR_URL / VITE_HERDR_TOKEN). */
export interface HerdrDefaults {
  url: string;
  token: string;
}

export function loadHerdrDefaults(): HerdrDefaults {
  return {
    url: import.meta.env.VITE_HERDR_URL ?? "",
    token: import.meta.env.VITE_HERDR_TOKEN ?? "",
  };
}

/** Relay URL scheme gate — the ONE regex shared by the form check and the connect logic. */
export const HERDR_URL_RE = /^wss?:\/\//i;

/**
 * The effective Herdr endpoint: the profile's `herdr` section wins, env
 * defaults fill the gaps, and anything missing or not ws/wss is null = feature
 * OFF. A misconfigured relay degrades silently — it must never surface as a
 * validation error that blocks the Hermes bridge connect.
 */
export function resolveHerdrProfile(
  profile: ConnectionProfile | null,
  defaults: HerdrDefaults,
): HerdrEndpoint | null {
  const url = profile?.herdr?.url || defaults.url;
  const token = profile?.herdr?.token || defaults.token;
  if (!url || !token) return null;
  if (!HERDR_URL_RE.test(url)) return null;
  return { url, token };
}

/**
 * Inline error for the phone "Herdr relay (optional)" form, computed from the
 * SAVED profile section (input arrives trimmed via normalizeHerdrSection).
 * Off (no section at all) is a valid state — null, never an error. This never
 * gates the bridge save: the relay has its own Save button.
 */
export function herdrSectionError(h?: HerdrEndpoint): string | null {
  const url = h?.url ?? "";
  const token = h?.token ?? "";
  if (!url && !token) return null;
  if (url && !token) return "Relay token is required when a relay URL is set.";
  if (!url && token) return "Relay URL is required (wss://…/herdr).";
  if (!HERDR_URL_RE.test(url)) return "Relay URL must start with wss:// or ws://. Herdr stays off until fixed.";
  return null;
}
