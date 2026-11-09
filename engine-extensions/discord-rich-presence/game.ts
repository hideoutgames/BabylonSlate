import { settings } from "haptic:extension";

/** What a presence node reports: whether Discord took it, and why not. */
interface PresenceResult {
  ok: boolean;
  error: string;
}

/** When Start ran; Show Elapsed Time counts from it. */
let startedAt = 0;

// #if WITH_DESKTOP
/** Desktop games and Play in the desktop editor answer this path on the game's own origin. */
const PRESENCE_PATH = "/.haptic/discord-presence";

async function send(activity: Record<string, unknown> | null): Promise<PresenceResult> {
  const applicationId = String(settings.applicationId ?? "").trim();
  if (!applicationId) return { ok: false, error: "Set the Application ID in Project Settings > Discord." };
  try {
    const response = await fetch(new URL(PRESENCE_PATH, globalThis.location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId, activity }),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    return result.ok ? { ok: true, error: "" } : { ok: false, error: result.error ?? `Discord Rich Presence failed (${response.status}).` };
  } catch (error) {
    return { ok: false, error: `Discord Rich Presence is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
// #endif

/** What every node reports where Discord Rich Presence does not run. */
const UNAVAILABLE: PresenceResult = { ok: false, error: "Discord Rich Presence works only in desktop games and Play in the desktop editor." };

/** Reports UNAVAILABLE; desktop builds send to Discord instead, and other builds leave the Discord code out. */
const presence: { send: (activity: Record<string, unknown> | null) => Promise<PresenceResult> } = { send: async () => UNAVAILABLE };
// #if WITH_DESKTOP
presence.send = send;
// #endif

export async function start(): Promise<{ connected: boolean; error: string }> {
  startedAt = Date.now();
  const result = await presence.send(null);
  return { connected: result.ok, error: result.error };
}

export async function update(
  details: string,
  state: string,
  largeImage: string,
  largeImageText: string,
  smallImage: string,
  smallImageText: string,
  showElapsedTime: boolean,
  partySize: number,
  partyMax: number,
): Promise<{ updated: boolean; error: string }> {
  const result = await presence.send({
    details,
    state,
    largeImage,
    largeText: largeImageText,
    smallImage,
    smallText: smallImageText,
    ...(showElapsedTime ? { startTimestamp: startedAt || Date.now() } : {}),
    partySize,
    partyMax,
  });
  return { updated: result.ok, error: result.error };
}

export async function clear(): Promise<{ cleared: boolean; error: string }> {
  const result = await presence.send(null);
  return { cleared: result.ok, error: result.error };
}
