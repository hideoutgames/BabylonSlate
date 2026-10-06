import { expect, it } from "vitest";
import { Actor, ActorComponent, MaterialObject } from "@babylonslate/object-model";
import { ScriptHost, type ScriptHostServices } from "./script-host";

function services(extra: Partial<ScriptHostServices>): ScriptHostServices {
  return { log() {}, print() {}, destroyActor() {}, executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError() {}, ...extra };
}

function preparation() {
  const ready = new Set<string>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  return {
    pending,
    services: {
      prepareAssets: (guids: readonly string[]) => new Promise<void>((resolve, reject) => {
        pending.set(guids[0]!, { resolve: () => { ready.add(guids[0]!); resolve(); }, reject });
      }),
      getAssetLoadState: (guid: string) => ready.has(guid) ? "ready" as const : "unloaded" as const,
    },
  };
}

it("preserves the previous material on cold failure and publishes only the latest replacement", async () => {
  const loading = preparation();
  const actor = new Actor({ classId: "Hero", guid: "hero" });
  const mesh = new ActorComponent({ classId: "MeshComponent", guid: "mesh", variables: { materialGuid: "previous" } });
  const ctx = new ScriptHost(services(loading.services)).createContext(actor, 0, 0);
  expect(() => ctx.setMeshMaterial(mesh, "cold")).toThrow("setMeshMaterialAsync");
  const failed = ctx.setMeshMaterialAsync(mesh, "missing");
  const rejection = expect(failed).rejects.toThrow("Missing material");
  expect(mesh.getVariable("materialGuid")).toBe("previous");
  loading.pending.get("missing")!.reject(new Error("Missing material"));
  await rejection;
  expect(mesh.getVariable("materialGuid")).toBe("previous");
  const stale = ctx.setMeshMaterialAsync(mesh, "first");
  const cancelled = expect(stale).rejects.toMatchObject({ name: "AbortError" });
  const current = ctx.setMeshMaterialAsync(mesh, "second");
  loading.pending.get("second")!.resolve();
  await current;
  loading.pending.get("first")!.resolve();
  await cancelled;
  expect(mesh.getVariable("materialGuid")).toBe("second");
});

it("keeps texture parameters unchanged until ready and rejects completion after caller destruction", async () => {
  const loading = preparation();
  const actor = new Actor({ classId: "Hero", guid: "hero" });
  const mesh = new ActorComponent({ classId: "MeshComponent", guid: "mesh" });
  actor.attachComponent(mesh);
  mesh.setVariable("materialGuid", "material");
  const material = mesh.getVariable("materialObject") as MaterialObject;
  const published: unknown[] = [];
  const ctx = new ScriptHost(services({ ...loading.services, setMaterialParameter: (_material, _name, value) => published.push(value) })).createContext(actor, 0, 0);
  const operation = ctx.setMaterialTextureParameterAsync(material, "Diffuse", "texture");
  const cancelled = expect(operation).rejects.toMatchObject({ name: "AbortError" });
  expect(published).toEqual([]);
  actor.destroyed = true;
  loading.pending.get("texture")!.resolve();
  await cancelled;
  expect(published).toEqual([]);
});

it("hands material ownership to the replacement and releases superseded source preloads", async () => {
  const actor = new Actor({ classId: "Hero", guid: "hero" });
  const mesh = new ActorComponent({ classId: "MeshComponent", guid: "mesh" });
  const released: string[] = [];
  const ctx = new ScriptHost(services({
    prepareAssets: async () => {},
    preloadAssets: async (guids, owner) => {
      expect(owner).toBe(mesh);
      return { success: true, progress: 1, preloadId: `preload:${guids[0]}`, errorMessage: "" };
    },
    releasePreload: id => { released.push(id); },
    getAssetLoadState: () => "ready",
  })).createContext(actor, 0, 0);
  await ctx.setMeshMaterialAsync(mesh, "first");
  expect(released).toEqual([]);
  await ctx.setMeshMaterialAsync(mesh, "second");
  expect(released).toEqual(["preload:first"]);
  ctx.setMeshMaterial(mesh, null);
  expect(released).toEqual(["preload:first", "preload:second"]);
});
