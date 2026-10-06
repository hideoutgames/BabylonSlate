import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSaveGameStorage } from "@babylonslate/vfs/save-game-node";
import { DesktopSaveGames } from "./desktop-save-games";

const directories: string[] = [];
async function createHost() {
  const directory = await mkdtemp(join(tmpdir(), "slate-save-host-"));
  directories.push(directory);
  return new DesktopSaveGames(new NodeSaveGameStorage(directory));
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("desktop save IPC ownership", () => {
  it("confines locked access and prevents a second window releasing another window's transaction", async () => {
    const host = await createHost();
    const token = await host.acquire(1, "project/game");
    await host.write(1, "project/game/default/generation-a.save", "saved");
    await expect(host.release(2, token)).rejects.toThrow("owner");
    await expect(host.read(2, "project/game/default/generation-a.save")).rejects.toThrow("owned lock");
    await expect(host.write(1, "other/game/save", "escape")).rejects.toThrow("owned lock");
    expect(await host.read(1, "project/game/default/generation-a.save")).toBe("saved");
    await host.release(1, token);
  });

  it("releases a crashed window's locks and cancels its queued acquisition", async () => {
    const host = await createHost();
    await host.acquire(1, "project/game");
    const cancelled = host.acquire(2, "project/game");
    const rejection = expect(cancelled).rejects.toThrow("owner closed");
    await host.releaseOwner(2);
    const successor = host.acquire(3, "project/game");
    await host.releaseOwner(1);
    await rejection;
    const token = await successor;
    await host.write(3, "project/game/default/generation-a.save", "recovered");
    expect(await host.read(3, "project/game/default/generation-a.save")).toBe("recovered");
    await host.release(3, token);
  });

  it("returns error categories in a serializable envelope", async () => {
    const host = await createHost();
    expect(await host.result(async () => { throw Object.assign(new Error("Disk full"), { name: "StorageFullError", code: "ENOSPC" }); }))
      .toEqual({ ok: false, error: { name: "StorageFullError", message: "Disk full", code: "ENOSPC" } });
  });
});
