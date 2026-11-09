import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiscordPresence,
  discordActivityPayload,
  discordIpcPaths,
  handleDiscordPresenceRequest,
  parseDiscordPresenceRequest,
  type DiscordPresence,
} from "./discord-presence";

const APP = "123456789012345678";

describe("parseDiscordPresenceRequest", () => {
  it("keeps the fields Discord shows, trimmed, and leaves out empty text and zero party sizes", () => {
    expect(parseDiscordPresenceRequest({ applicationId: APP, activity: {
      details: "  Harbour Run  ", state: "", largeImage: "map", largeText: "Docks", smallImage: " ", partySize: 0, partyMax: 0, startTimestamp: 1_700_000_000_000,
    } })).toEqual({ applicationId: APP, activity: { details: "Harbour Run", largeImage: "map", largeText: "Docks", startTimestamp: 1_700_000_000_000 } });
    expect(parseDiscordPresenceRequest({ applicationId: APP, activity: null })).toEqual({ applicationId: APP, activity: null });
  });

  it.each([
    [{ applicationId: "abc", activity: null }, "The Application ID must be the 17 to 20 digit ID"],
    [{ applicationId: "1234", activity: null }, "The Application ID must be the 17 to 20 digit ID"],
    [{ applicationId: APP, activity: { buttons: [] } }, "Unknown activity field buttons."],
    [{ applicationId: APP, activity: { details: 3 } }, "details must be text."],
    [{ applicationId: APP, activity: { state: "x".repeat(129) } }, "state is longer than 128 characters."],
    [{ applicationId: APP, activity: { largeImage: "x".repeat(257) } }, "largeImage is longer than 256 characters."],
    [{ applicationId: APP, activity: { partySize: 2 } }, "A party needs both a size and a maximum."],
    [{ applicationId: APP, activity: { partySize: 5, partyMax: 4 } }, "The party size is larger than its maximum."],
    [{ applicationId: APP, activity: { partySize: 1.5, partyMax: 4 } }, "partySize must be a whole number from 0."],
    [{ applicationId: APP, activity: { startTimestamp: -1 } }, "startTimestamp must be a Unix time in milliseconds."],
    [[APP], "The request is not an object."],
  ])("rejects %j", (request, message) => {
    expect(() => parseDiscordPresenceRequest(request)).toThrow(message);
  });
});

describe("discordActivityPayload", () => {
  it("writes Discord's SET_ACTIVITY shape", () => {
    expect(discordActivityPayload({
      details: "Harbour Run", state: "In a race", startTimestamp: 5, largeImage: "map", largeText: "Docks", smallImage: "boat", smallText: "Skiff", partySize: 2, partyMax: 4,
    })).toEqual({
      details: "Harbour Run", state: "In a race", timestamps: { start: 5 },
      assets: { large_image: "map", large_text: "Docks", small_image: "boat", small_text: "Skiff" },
      party: { size: [2, 4] }, instance: false,
    });
    expect(discordActivityPayload({})).toEqual({ instance: false });
  });
});

describe("discordIpcPaths", () => {
  it("lists Windows pipes, the macOS runtime folder and Linux's Flatpak and Snap folders", () => {
    expect(discordIpcPaths("win32", {}).slice(0, 2)).toEqual(["\\\\?\\pipe\\discord-ipc-0", "\\\\?\\pipe\\discord-ipc-1"]);
    expect(discordIpcPaths("darwin", { TMPDIR: "/var/folders/x/T/" })).toHaveLength(10);
    expect(discordIpcPaths("darwin", { TMPDIR: "/var/folders/x/T/" })[0]).toBe("/var/folders/x/T/discord-ipc-0");
    const linux = discordIpcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/tmp" });
    expect([linux[0], linux[10], linux[20], linux.length]).toEqual([
      "/run/user/1000/discord-ipc-0", "/run/user/1000/app/com.discordapp.Discord/discord-ipc-0", "/run/user/1000/snap.discord/discord-ipc-0", 30,
    ]);
    expect(discordIpcPaths("linux", {})[0]).toBe("/tmp/discord-ipc-0");
  });
});

/** A stand-in for the Discord app: answers the handshake and SET_ACTIVITY as Discord does, and records frames. */
async function fakeDiscord(options: { refuse?: string; closeOnHandshake?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "discord-ipc-"));
  const path = join(directory, "discord-ipc-0");
  const frames: { op: number; body: Record<string, unknown> }[] = [];
  const sockets = new Set<Socket>();
  const send = (socket: Socket, op: number, body: unknown) => {
    const json = Buffer.from(JSON.stringify(body));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(json.length, 4);
    socket.write(Buffer.concat([header, json]));
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 8 && buffered.length >= 8 + buffered.readUInt32LE(4)) {
        const op = buffered.readUInt32LE(0);
        const body = JSON.parse(buffered.subarray(8, 8 + buffered.readUInt32LE(4)).toString()) as Record<string, unknown>;
        buffered = buffered.subarray(8 + buffered.readUInt32LE(4));
        frames.push({ op, body });
        if (op === 0 && options.closeOnHandshake) send(socket, 2, { code: 4000, message: options.closeOnHandshake });
        else if (op === 0) send(socket, 1, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } });
        else if (op === 1 && options.refuse) send(socket, 1, { cmd: "SET_ACTIVITY", evt: "ERROR", nonce: body.nonce, data: { code: 4000, message: options.refuse } });
        else if (op === 1) send(socket, 1, { cmd: "SET_ACTIVITY", evt: null, nonce: body.nonce, data: {} });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    frames,
    ping: (socketIndex = 0) => send([...sockets][socketIndex]!, 3, { ping: 1 }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function presenceWith(discord: Awaited<ReturnType<typeof fakeDiscord>> | null): Promise<DiscordPresence> {
  const missing = join(tmpdir(), "no-discord-here", "discord-ipc-0");
  const presence = createDiscordPresence({ paths: () => [missing, ...(discord ? [discord.path] : [])], pid: 4242, timeoutMs: 2000 });
  cleanups.push(() => presence.dispose());
  return presence;
}

describe("createDiscordPresence", () => {
  it("shakes hands with the Application ID once, then sets and clears the activity with this process's pid", async () => {
    const discord = await fakeDiscord();
    cleanups.push(discord.close);
    const presence = await presenceWith(discord);

    await presence.set({ applicationId: APP, activity: { details: "Harbour Run", partySize: 1, partyMax: 4 } });
    await presence.set({ applicationId: APP, activity: null });

    expect(discord.frames.map((frame) => frame.op)).toEqual([0, 1, 1]);
    expect(discord.frames[0]!.body).toEqual({ v: 1, client_id: APP });
    expect(discord.frames[1]!.body).toMatchObject({ cmd: "SET_ACTIVITY", args: { pid: 4242, activity: { details: "Harbour Run", party: { size: [1, 4] }, instance: false } } });
    expect(discord.frames[2]!.body).toMatchObject({ cmd: "SET_ACTIVITY", args: { pid: 4242 } });
    expect(discord.frames[2]!.body.args).not.toHaveProperty("activity");
  });

  it("connects again when the Application ID changes", async () => {
    const discord = await fakeDiscord();
    cleanups.push(discord.close);
    const presence = await presenceWith(discord);
    await presence.set({ applicationId: APP, activity: null });
    await presence.set({ applicationId: "987654321098765432", activity: null });
    expect(discord.frames.filter((frame) => frame.op === 0).map((frame) => frame.body.client_id)).toEqual([APP, "987654321098765432"]);
  });

  it("answers Discord's ping with a pong carrying the same payload", async () => {
    const discord = await fakeDiscord();
    cleanups.push(discord.close);
    const presence = await presenceWith(discord);
    await presence.set({ applicationId: APP, activity: null });
    discord.ping();
    await expect.poll(() => discord.frames.find((frame) => frame.op === 4)?.body).toEqual({ ping: 1 });
  });

  it.each([
    [{ refuse: "Invalid asset" }, "Discord refused the presence: Invalid asset."],
    [{ closeOnHandshake: "Invalid Client ID" }, "Discord closed the connection: Invalid Client ID."],
  ])("explains why Discord did not take the presence (%j)", async (options, message) => {
    const discord = await fakeDiscord(options);
    cleanups.push(discord.close);
    const presence = await presenceWith(discord);
    await expect(presence.set({ applicationId: APP, activity: { details: "Harbour Run" } })).rejects.toThrow(message);
  });

  it("says Discord is not running when no socket answers", async () => {
    const presence = await presenceWith(null);
    await expect(presence.set({ applicationId: APP, activity: null })).rejects.toThrow("Discord is not running on this computer.");
  });
});

describe("handleDiscordPresenceRequest", () => {
  const sent: unknown[] = [];
  const presence: DiscordPresence = { set: async (request) => { sent.push(request); }, dispose: () => undefined };
  const post = (body: unknown, headers: Record<string, string> = { origin: "app://game", "content-type": "application/json" }, method = "POST") =>
    handleDiscordPresenceRequest(new Request("app://game/.haptic/discord-presence", { method, headers, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }), "app://game", presence);

  it("sets a checked presence for the game's own origin", async () => {
    sent.length = 0;
    const response = await post({ applicationId: APP, activity: { details: "Harbour Run" } });
    expect([response.status, await response.json()]).toEqual([200, { ok: true }]);
    expect(sent).toEqual([{ applicationId: APP, activity: { details: "Harbour Run" } }]);
  });

  it.each([
    [{ origin: "https://example.com", "content-type": "application/json" }, "POST", 403],
    [{ origin: "app://game", "content-type": "text/plain" }, "POST", 415],
    [{ origin: "app://game", "content-type": "application/json" }, "GET", 405],
  ])("refuses headers %j with %s", async (headers, method, status) => {
    sent.length = 0;
    const response = await post({ applicationId: APP, activity: null }, headers, method);
    expect(response.status).toBe(status);
    expect(sent).toEqual([]);
  });

  it("reports a malformed request without reaching Discord", async () => {
    sent.length = 0;
    const response = await post({ applicationId: "nope", activity: null });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Application ID");
    expect(sent).toEqual([]);
  });
});
