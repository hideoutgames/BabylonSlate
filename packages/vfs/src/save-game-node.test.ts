import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSaveGameStorage } from "./save-game-node";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "slate-save-games-"));
  roots.push(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("desktop private save storage", () => {
  it("atomically replaces generations and reopens case-distinct slot names", async () => {
    const directory = await root();
    const storage = new NodeSaveGameStorage(directory);
    await storage.write("project/game/default/generation-a.save", "first");
    await storage.write("project/game/Default/generation-a.save", "capital");
    await storage.write("project/game/default/generation-a.save", "replacement");
    const reopened = new NodeSaveGameStorage(directory);
    expect(await reopened.read("project/game/default/generation-a.save")).toBe("replacement");
    expect(await reopened.read("project/game/Default/generation-a.save")).toBe("capital");
    expect(await reopened.list("project/game")).toEqual([
      "project/game/Default/generation-a.save", "project/game/default/generation-a.save",
    ]);
    await reopened.remove("project/game/default/generation-a.save");
    expect(await reopened.read("project/game/default/generation-a.save")).toBeNull();
    expect(await reopened.read("project/game/Default/generation-a.save")).toBe("capital");
  });

  it("serializes main-process read-modify-write transactions across adapter instances", async () => {
    const directory = await root();
    const first = new NodeSaveGameStorage(directory);
    const second = new NodeSaveGameStorage(directory);
    const key = "project/game/generation-a.save";
    await first.write(key, "0");
    await Promise.all(Array.from({ length: 10 }, (_, index) => {
      const storage = index % 2 ? first : second;
      return storage.withLock("project/game", async () => {
        const value = Number(await storage.read(key));
        await storage.write(key, String(value + 1));
      });
    }));
    expect(await first.read(key)).toBe("10");
    await expect(first.withLock("project/game", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(await second.withLock("project/game", () => second.read(key))).toBe("10");
  });

  it("never treats inaccessible storage as missing or escapes the save root", async () => {
    const directory = await root();
    const blocker = join(directory, "not-a-directory");
    await writeFile(blocker, "occupied");
    const unavailable = new NodeSaveGameStorage(blocker);
    await expect(unavailable.read("project/file")).rejects.toHaveProperty("code", "ENOTDIR");
    await expect(unavailable.list("project")).rejects.toHaveProperty("code", "ENOTDIR");
    const storage = new NodeSaveGameStorage(directory);
    for (const path of ["../outside", "/outside", "a/../../outside", "a\\outside"]) {
      await expect(storage.write(path, "data")).rejects.toThrow();
    }
    expect(await storage.read("project/missing")).toBeNull();
  });
});
