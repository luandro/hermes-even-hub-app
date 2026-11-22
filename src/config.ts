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
  if (!/^wss?:\/\//i.test(url)) return null;
  return { url, token };
}
