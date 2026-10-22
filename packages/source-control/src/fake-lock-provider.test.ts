import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@haptic/core";
import { FakeLockProvider } from "./fake-lock-provider";

describe("FakeLockProvider", () => {
  it("creates a lock as ours and records it", async () => {
    const provider = new FakeLockProvider({ selfName: "Ada" });
    const created = await provider.create("assets/hero.scene.hasset");
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.value.ours).toBe(true);
    expect(created.value.ownerName).toBe("Ada");
    expect(created.value.path).toBe("assets/hero.scene.hasset");

    expect(provider.snapshot()).toEqual([created.value]);
  });

  it("returns 409-style conflict when another holder already locked the path", async () => {
    const provider = new FakeLockProvider({ selfName: "Ada" });
    provider.addTheirs("assets/hero.scene.hasset", "Bob");
    const created = await provider.create("assets/hero.scene.hasset");
    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.kind).toBe("conflict");
    expect(created.error.lock?.ownerName).toBe("Bob");
    expect(created.error.lock?.ours).toBe(false);
  });

  it("conflicts when we already hold the path", async () => {
    const provider = new FakeLockProvider({ selfName: "Ada" });
    await provider.create("assets/a.hasset");
    const again = await provider.create("assets/a.hasset");
    expect(isErr(again) && again.error.kind).toBe("conflict");
    if (!isErr(again)) return;
    expect(again.error.lock?.ours).toBe(true);
  });

  it("splits verify into ours and theirs", async () => {
    const provider = new FakeLockProvider({ selfName: "Ada" });
    await provider.create("assets/mine.hasset");
    provider.addTheirs("assets/theirs.hasset", "Bob");
    const verified = await provider.verify();
    expect(isOk(verified)).toBe(true);
    if (!isOk(verified)) return;
    expect(verified.value.ours.map((lock) => lock.path)).toEqual([
      "assets/mine.hasset",
    ]);
    expect(verified.value.theirs.map((lock) => lock.path)).toEqual([
      "assets/theirs.hasset",
    ]);
  });

  it("unlocks ours without force and refuses theirs until forced", async () => {
    const provider = new FakeLockProvider({ selfName: "Ada" });
    const mine = await provider.create("assets/mine.hasset");
    if (!isOk(mine)) throw new Error("expected create");
    const theirLock = provider.addTheirs("assets/theirs.hasset", "Bob");

    expect(isOk(await provider.unlock(mine.value.id))).toBe(true);
    const refused = await provider.unlock(theirLock.id);
    expect(isErr(refused) && refused.error.kind).toBe("http");
    expect(isOk(await provider.unlock(theirLock.id, { force: true }))).toBe(true);
    expect(provider.snapshot()).toHaveLength(0);
  });
});
