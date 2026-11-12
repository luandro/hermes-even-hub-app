import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

export interface ConnectionProfile {
  url: string;
  token: string;
  /** Optional hello device id (1-64 chars); omitted ⇒ the bridge defaults to "g2". */
  device?: string;
  activeSession?: string;
  updatedAt: number;
}

export interface ProfileValidation {
  valid: boolean;
  errors: string[];
}

const KEYS = {
  profile: "hermes.connectionProfile.v1",
  oldUrl: "hermes.lastUrl",
  oldSession: "hermes.activeSession",
} as const;

export function normalizeConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  return {
    url: profile.url.trim(),
    token: profile.token.trim(),
    device: normalizeDevice(profile.device),
    activeSession: profile.activeSession?.trim() || undefined,
    updatedAt: profile.updatedAt,
  };
}

/** Device id: trimmed, 1-64 chars, anything else falls back to the default. */
export function normalizeDevice(device: string | undefined): string | undefined {
  const trimmed = (device ?? "").trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  return trimmed;
}

export function validateConnectionProfile(
  profile: Pick<ConnectionProfile, "url" | "token" | "device">,
): ProfileValidation {
  const errors: string[] = [];
  const url = profile.url.trim();
  const token = profile.token.trim();

  if (!url) {
    errors.push("Bridge URL is required.");
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
        errors.push("Bridge URL must start with wss:// or ws://.");
      }
    } catch {
      errors.push("Bridge URL is invalid.");
    }
  }

  if (!token) errors.push("Bridge token is required.");

  const device = (profile.device ?? "").trim();
  if (device.length > 64) {
    errors.push("Device ID must be 1-64 characters.");
  }
  return { valid: errors.length === 0, errors };
}

export function isConfiguredProfile(profile: ConnectionProfile | null | undefined): profile is ConnectionProfile {
  return Boolean(profile && profile.token.trim() && validateConnectionProfile(profile).valid);
}

export const WHITELISTED_BRIDGE_HOST = "g2-bridge.taile61e1.ts.net";

export async function saveConnectionProfile(
  bridge: EvenAppBridge,
  profile: ConnectionProfile,
): Promise<ConnectionProfile> {
  const next = normalizeConnectionProfile(profile);
  try {
    const parsed = new URL(next.url);
    if (parsed.hostname !== WHITELISTED_BRIDGE_HOST) {
      console.warn(
        `Bridge URL host '${parsed.hostname}' is not in the whitelist set (${WHITELISTED_BRIDGE_HOST}).`,
      );
    }
  } catch {
    // Leave invalid URL reporting to profile validation
  }
  await bridge.setLocalStorage(KEYS.profile, JSON.stringify(next));
  return next;
}

export async function loadConnectionProfile(bridge: EvenAppBridge): Promise<ConnectionProfile | null> {
  const stored = await bridge.getLocalStorage(KEYS.profile);
  if (stored) {
    const parsed = parseProfile(stored);
    if (parsed) return parsed;
  }

  const url = await bridge.getLocalStorage(KEYS.oldUrl);
  const activeSession = await bridge.getLocalStorage(KEYS.oldSession);
  if (!url) return null;

  return {
    url,
    token: "",
    activeSession: activeSession || undefined,
    updatedAt: Date.now(),
  };
}

export async function updateActiveSession(
  bridge: EvenAppBridge,
  profile: ConnectionProfile,
  activeSession: string | null,
): Promise<ConnectionProfile> {
  return saveConnectionProfile(bridge, {
    ...profile,
    activeSession: activeSession || undefined,
    updatedAt: Date.now(),
  });
}

function parseProfile(raw: string): ConnectionProfile | null {
  try {
    const value = JSON.parse(raw) as Partial<ConnectionProfile>;
    if (typeof value.url !== "string" || typeof value.token !== "string") return null;
    return normalizeConnectionProfile({
      url: value.url,
      token: value.token,
      device: typeof value.device === "string" ? value.device : undefined,
      activeSession: typeof value.activeSession === "string" ? value.activeSession : undefined,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    });
  } catch {
    return null;
  }
}
