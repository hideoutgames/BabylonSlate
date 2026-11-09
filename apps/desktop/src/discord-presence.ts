import { randomUUID } from "node:crypto";
import { connect as connectSocket, type Socket } from "node:net";
import { join } from "node:path";

/**
 * Discord Rich Presence for desktop games and Play in the desktop editor: a client of the Discord app's local IPC
 * socket (`discord-ipc-<n>`), which needs only a public Application ID. Games reach it by posting to
 * {@link DISCORD_PRESENCE_PATH} on their own `app://` origin; nothing reaches Discord unchecked.
 */
export const DISCORD_PRESENCE_PATH = "/.haptic/discord-presence";

/** Rich Presence as Discord shows it; every field is optional. */
export interface DiscordActivity {
  details?: string;
  state?: string;
  /** Unix time in milliseconds the elapsed timer counts from. */
  startTimestamp?: number;
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
  partySize?: number;
  partyMax?: number;
}

export interface DiscordPresenceRequest {
  applicationId: string;
  /** null clears the presence. */
  activity: DiscordActivity | null;
}

const TEXT_FIELDS = ["details", "state", "largeText", "smallText"] as const;
const IMAGE_FIELDS = ["largeImage", "smallImage"] as const;
const ACTIVITY_FIELDS = new Set<string>([...TEXT_FIELDS, ...IMAGE_FIELDS, "startTimestamp", "partySize", "partyMax"]);
/** Discord's limits: 128 characters of text, 256 for an image key or URL. */
const TEXT_LIMIT = 128;
const IMAGE_LIMIT = 256;
const MAX_PARTY = 2_147_483_647;

/** A checked request, or an error naming what is wrong. Empty strings and zero party sizes are left out. */
export function parseDiscordPresenceRequest(value: unknown): DiscordPresenceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The request is not an object.");
  const { applicationId, activity } = value as { applicationId?: unknown; activity?: unknown };
  if (typeof applicationId !== "string" || !/^\d{17,20}$/.test(applicationId)) {
    throw new Error("The Application ID must be the 17 to 20 digit ID from the Discord Developer Portal.");
  }
  if (activity === null) return { applicationId, activity: null };
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) throw new Error("The activity is not an object.");
  const record = activity as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ACTIVITY_FIELDS.has(key));
  if (unknown.length) throw new Error(`Unknown activity field ${unknown.join(", ")}.`);
  const parsed: DiscordActivity = {};
  for (const [fields, limit] of [[TEXT_FIELDS, TEXT_LIMIT], [IMAGE_FIELDS, IMAGE_LIMIT]] as const) {
    for (const field of fields) {
      const text = record[field];
      if (text === undefined) continue;
      if (typeof text !== "string") throw new Error(`${field} must be text.`);
      const trimmed = text.trim();
      if ([...trimmed].length > limit) throw new Error(`${field} is longer than ${limit} characters.`);
      if (trimmed) parsed[field] = trimmed;
    }
  }
  for (const field of ["partySize", "partyMax"] as const) {
    const size = record[field];
    if (size === undefined) continue;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_PARTY) throw new Error(`${field} must be a whole number from 0.`);
    if (size > 0) parsed[field] = size;
  }
  if ((parsed.partySize === undefined) !== (parsed.partyMax === undefined)) throw new Error("A party needs both a size and a maximum.");
  if (parsed.partySize !== undefined && parsed.partySize > parsed.partyMax!) throw new Error("The party size is larger than its maximum.");
  const start = record.startTimestamp;
  if (start !== undefined) {
    if (typeof start !== "number" || !Number.isInteger(start) || start <= 0) throw new Error("startTimestamp must be a Unix time in milliseconds.");
    parsed.startTimestamp = start;
  }
  return { applicationId, activity: parsed };
}

/** The activity object Discord's SET_ACTIVITY takes. */
export function discordActivityPayload(activity: DiscordActivity): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (activity.details) payload.details = activity.details;
  if (activity.state) payload.state = activity.state;
  if (activity.startTimestamp) payload.timestamps = { start: activity.startTimestamp };
  const assets: Record<string, string> = {};
  if (activity.largeImage) assets.large_image = activity.largeImage;
  if (activity.largeText) assets.large_text = activity.largeText;
  if (activity.smallImage) assets.small_image = activity.smallImage;
  if (activity.smallText) assets.small_text = activity.smallText;
  if (Object.keys(assets).length) payload.assets = assets;
  if (activity.partySize && activity.partyMax) payload.party = { size: [activity.partySize, activity.partyMax] };
  payload.instance = false;
  return payload;
}

/** Where the Discord app listens, in the order Discord's own libraries try them. */
export function discordIpcPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const indices = Array.from({ length: 10 }, (_, index) => index);
  if (platform === "win32") return indices.map((index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  // Flatpak and Snap installs listen in their own folders under the runtime directory.
  const folders = platform === "linux" ? ["", "app/com.discordapp.Discord", "snap.discord"] : [""];
  return folders.flatMap((folder) => indices.map((index) => join(base, folder, `discord-ipc-${index}`)));
}

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

export interface DiscordPresenceOptions {
  /** Opens a socket to an IPC path; resolves once it is connected. */
  connect?: (path: string) => Promise<Socket>;
  paths?: () => string[];
  pid?: number;
  /** How long Discord has to answer the handshake or a command. */
  timeoutMs?: number;
}

function defaultConnect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export interface DiscordPresence {
  /** Sets (or with null, clears) the presence, connecting to Discord first if needed. Rejects with a readable reason. */
  set(request: DiscordPresenceRequest): Promise<void>;
  /** Closes the connection, which makes Discord drop the presence. */
  dispose(): void;
}

interface Connection {
  socket: Socket;
  applicationId: string;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  closed: boolean;
}

export function createDiscordPresence(options: DiscordPresenceOptions = {}): DiscordPresence {
  const connect = options.connect ?? defaultConnect;
  const paths = options.paths ?? (() => discordIpcPaths(process.platform, process.env));
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? 5000;
  let connection: Promise<Connection> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const close = (current: Connection, reason: string) => {
    if (current.closed) return;
    current.closed = true;
    current.socket.destroy();
    for (const waiting of current.pending.values()) waiting.reject(new Error(reason));
    current.pending.clear();
  };

  const open = async (applicationId: string): Promise<Connection> => {
    let socket: Socket | null = null;
    for (const path of paths()) {
      try {
        socket = await connect(path);
        break;
      } catch {
        // Not listening there; try the next path.
      }
    }
    if (!socket) throw new Error("Discord is not running on this computer.");
    const current: Connection = { socket, applicationId, pending: new Map(), closed: false };
    let buffered = Buffer.alloc(0);
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A closed connection is replaced by the next request (`set` checks `closed`).
    const fail = (reason: string) => {
      readyReject?.(new Error(reason));
      close(current, reason);
    };
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 8) {
        const op = buffered.readUInt32LE(0);
        const length = buffered.readUInt32LE(4);
        if (buffered.length < 8 + length) break;
        const body = buffered.subarray(8, 8 + length).toString("utf8");
        buffered = buffered.subarray(8 + length);
        let message: { cmd?: string; evt?: string | null; nonce?: string; data?: { code?: number; message?: string } & Record<string, unknown>; code?: number; message?: string };
        try {
          message = JSON.parse(body);
        } catch {
          fail("Discord sent a message that is not JSON.");
          return;
        }
        if (op === OP_PING) {
          socket!.write(encodeFrame(OP_PONG, message));
        } else if (op === OP_CLOSE) {
          fail(`Discord closed the connection: ${message.message ?? "no reason given"}.`);
          return;
        } else if (op === OP_FRAME) {
          if (message.cmd === "DISPATCH" && message.evt === "READY") {
            readyResolve?.();
            readyResolve = null;
            readyReject = null;
          } else if (message.nonce && current.pending.has(message.nonce)) {
            const waiting = current.pending.get(message.nonce)!;
            current.pending.delete(message.nonce);
            if (message.evt === "ERROR") waiting.reject(new Error(`Discord refused the presence: ${message.data?.message ?? "no reason given"}.`));
            else waiting.resolve(message.data);
          }
        }
      }
    });
    socket.on("error", () => fail("The connection to Discord failed."));
    socket.on("close", () => fail("Discord closed the connection."));
    socket.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: applicationId }));
    const timer = setTimeout(() => fail("Discord did not answer."), timeoutMs);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
    return current;
  };

  const command = (current: Connection, activity: Record<string, unknown> | null): Promise<unknown> => new Promise((resolve, reject) => {
    const nonce = randomUUID();
    const timer = setTimeout(() => {
      current.pending.delete(nonce);
      reject(new Error("Discord did not answer."));
    }, timeoutMs);
    current.pending.set(nonce, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    current.socket.write(encodeFrame(OP_FRAME, { cmd: "SET_ACTIVITY", args: { pid, ...(activity ? { activity } : {}) }, nonce }));
  });

  const set = async (request: DiscordPresenceRequest): Promise<void> => {
    let current = connection ? await connection.catch(() => null) : null;
    if (current && (current.closed || current.applicationId !== request.applicationId)) {
      close(current, "The Application ID changed.");
      current = null;
    }
    if (!current) {
      connection = open(request.applicationId);
      try {
        current = await connection;
      } catch (error) {
        connection = null;
        throw error;
      }
    }
    await command(current, request.activity ? discordActivityPayload(request.activity) : null);
  };

  return {
    // One request at a time, so an update never overtakes the one before it.
    set: (request) => {
      const run = queue.then(() => set(request));
      queue = run.catch(() => undefined);
      return run;
    },
    dispose: () => {
      const pending = connection;
      connection = null;
      void pending?.then((current) => close(current, "Discord Rich Presence stopped."), () => undefined);
    },
  };
}

/**
 * Answers a game's presence request on its own `app://` origin: POST, JSON, at most 16 KiB, from `origin` itself.
 * A page on another origin cannot send it: the JSON content type needs a preflight, which the app protocol refuses,
 * and the Origin header is checked as well.
 */
export async function handleDiscordPresenceRequest(request: Request, origin: string, presence: DiscordPresence): Promise<Response> {
  const reply = (status: number, body: { ok: boolean; error?: string }) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (request.method !== "POST") return reply(405, { ok: false, error: "Use POST." });
  if (request.headers.get("origin") !== origin) return reply(403, { ok: false, error: "Only the game may set its presence." });
  if (!/^application\/json\b/.test(request.headers.get("content-type") ?? "")) return reply(415, { ok: false, error: "Send JSON." });
  const text = await request.text();
  if (text.length > 16 * 1024) return reply(413, { ok: false, error: "The request is too large." });
  let parsed: DiscordPresenceRequest;
  try {
    parsed = parseDiscordPresenceRequest(JSON.parse(text));
  } catch (error) {
    return reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  try {
    await presence.set(parsed);
    return reply(200, { ok: true });
  } catch (error) {
    return reply(503, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
