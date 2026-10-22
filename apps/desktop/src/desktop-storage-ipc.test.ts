import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import { LIBRARY_FOLDERS } from "@haptic/vfs/library-folders";
import { DesktopLibraries, libraryIpcHandlers } from "./desktop-storage-ipc";
import { knownProjectFolder, validateIpcArguments } from "./packaged-security";

let userData: string;
let projectsHome: string;
let librariesHome: string;
let handlers: ReturnType<typeof libraryIpcHandlers>;

/** As main's `handle`: validate the arguments, then run the channel's listener for one document. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  validateIpcArguments(channel, args);
  const listener = handlers[channel];
  if (!listener) throw new Error(`No handler for ${channel}`);
  const [scope, ...rest] = args;
  return listener(1, scope, ...rest);
}

beforeEach(async () => {
  userData = await realpath(await mkdtemp(join(tmpdir(), "haptic-libraries-")));
  projectsHome = join(userData, "projects");
  librariesHome = join(userData, "libraries");
  await mkdir(projectsHome);
  await mkdir(librariesHome);
  handlers = libraryIpcHandlers(new DesktopLibraries(librariesHome));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("desktop user library IPC", () => {
  it("stores each allowlisted library as its own folder under userData/libraries", async () => {
    await invoke("library:writeBinary", "__slate_templates__", "Starter.zip", new Uint8Array([1, 2, 3]).buffer);
    await invoke("library:writeBinary", "__slate_engine_plugins__", "catalog.json", new TextEncoder().encode("{}").buffer);

    expect(await readFile(join(librariesHome, "__slate_templates__", "Starter.zip"))).toEqual(Buffer.from([1, 2, 3]));
    expect(new Uint8Array(await invoke("library:readBinary", "__slate_templates__", "Starter.zip") as ArrayBuffer))
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(await invoke("library:readBinaryRange", "__slate_templates__", "Starter.zip", 1, 2, undefined))
      .toMatchObject({ totalSize: 3, actualBytesRead: 2 });
    expect(await invoke("library:exists", "__slate_engine_plugins__", "Starter.zip")).toBe(false);
    expect(await invoke("library:readdir", "__slate_engine_extensions__", "")).toEqual([]);
    await invoke("library:remove", "__slate_templates__", "Starter.zip");
    expect(await readdir(join(librariesHome, "__slate_templates__"))).toEqual([]);
  });

  it("keeps libraries out of the project list and project reopen", async () => {
    for (const scope of LIBRARY_FOLDERS) await invoke("library:mkdir", scope, "entries", true);

    expect(await new NodeStorageAdapter(projectsHome).listProjects()).toEqual([]);
    await expect(knownProjectFolder(`node:${join(librariesHome, "__slate_templates__")}`, projectsHome, async () => []))
      .rejects.toThrow("folder picker");
  });

  it("refuses scopes outside the allowlist and paths that leave the library", async () => {
    for (const scope of ["projects", "__haptic_derived__", "../projects", "__slate_templates__/..", "", "/etc", {}, null]) {
      await expect(invoke("library:exists", scope, "project.json")).rejects.toThrow("Invalid desktop request");
    }
    for (const path of ["../__slate_engine_plugins__/catalog.json", "../../projects/Game/project.json", "/etc/passwd", "C:\\secret", "a/../../b"]) {
      await expect(invoke("library:writeBinary", "__slate_templates__", path, new ArrayBuffer(1))).rejects.toThrow("Invalid desktop request");
    }
    // The bind itself also refuses a scope that skipped validation.
    await expect(handlers["library:exists"]!(1, "projects", "project.json")).rejects.toThrow("Invalid desktop request");
    expect(await readdir(librariesHome)).toEqual([]);
    expect(await readdir(projectsHome)).toEqual([]);
  });

  it("offers no project-only channel for a library and no scope on project channels", async () => {
    for (const [channel, args] of [
      ["library:pickFolder", ["__slate_templates__"]],
      ["library:openKnown", ["__slate_templates__", { id: `node:${projectsHome}`, name: "Game", tier: "external" }]],
      ["library:list", ["__slate_templates__"]],
      ["library:openDocuments", ["__slate_templates__", "Game"]],
      ["library:release", ["__slate_templates__"]],
      ["project:readBinary", ["__slate_templates__", "Starter.zip"]],
    ] as Array<[string, unknown[]]>) {
      expect(handlers[channel]).toBeUndefined();
      await expect(invoke(channel, ...args)).rejects.toThrow("Invalid desktop request");
    }
  });

  it("refuses a library folder replaced by a link out of the libraries home", async () => {
    const outside = join(userData, "outside");
    await mkdir(outside);
    // Junctions need no privilege on Windows; other hosts create directory links.
    await symlink(outside, join(librariesHome, "__slate_engine_extensions__"), "junction");

    await expect(invoke("library:writeBinary", "__slate_engine_extensions__", "x.zip", new ArrayBuffer(1)))
      .rejects.toThrow("not inside the libraries home");
    expect(await readdir(outside)).toEqual([]);
  });
});
