import { describe, expect, it } from "vitest";
import { SaveGameService, type SaveGameDefinition, type SaveGameStorage } from "@babylonslate/core";
import { Actor } from "@babylonslate/object-model";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ScriptHost, type ScriptHostServices } from "./script-host";

function storage(): SaveGameStorage {
  const files = new Map<string, string>();
  return { read: async (key) => files.get(key) ?? null, write: async (key, value) => { files.set(key, value); },
    remove: async (key) => { files.delete(key); }, list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
    withLock: async (_key, operation) => operation() };
}
function services(extra: Partial<ScriptHostServices> = {}): ScriptHostServices {
  return { log: () => {}, print: () => {}, destroyActor: () => {}, delay: async () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }), reportError: () => {}, ...extra };
}
const definition: SaveGameDefinition = { id: "progress", schemaVersion: 1, fields: [{ id: "coins", name: "Coins", type: "int", defaultValue: 0 }] };

describe("ScriptHost save APIs", () => {
  it("saves and reloads typed data through the same context, with explicit missing/deleted results", async () => {
    const host = new ScriptHost(services());
    const ctx = host.createContext(null, 0, 0);
    expect(await ctx.loadGame()).toMatchObject({ ok: false, error: { code: "unavailable" } });
    host.setSaveGameService(new SaveGameService({ projectId: "project", definition, storage: storage() }));
    expect(await ctx.loadGame()).toMatchObject({ ok: false, error: { code: "missing" } });
    ctx.getSaveData<{ Coins: number }>().Coins = 21;
    expect(await ctx.saveGame({ slot: "checkpoint" })).toMatchObject({ ok: true, value: { slot: "checkpoint" } });
    expect(await ctx.newGame()).toMatchObject({ ok: true, value: { Coins: 0 } });
    expect(await ctx.loadGame({ slot: "checkpoint" })).toMatchObject({ ok: true });
    expect(ctx.getSaveData()).toEqual({ Coins: 21 });
    const saves = await ctx.listSaves();
    expect(saves.ok && saves.value.map((save) => save.slot)).toEqual(["checkpoint"]);
    expect(await ctx.deleteSave({ slot: "checkpoint" })).toEqual({ ok: true, value: undefined });
    expect(await ctx.loadGame({ slot: "checkpoint" })).toMatchObject({ ok: false, error: { code: "missing" } });
    expect(ctx.getSaveData()).toEqual({ Coins: 21 });
  });

  it("maps typed actor fields through persistent IDs, including arrays", () => {
    const hero = new Actor({ classId: "Actor", guid: "runtime-hero" });
    const saveGame = new SaveGameService({ projectId: "project", storage: storage(), definition: { id: "party", schemaVersion: 1,
      fields: [{ id: "members", name: "Party", type: "actor", array: true, defaultValue: [] }] } });
    const ctx = new ScriptHost(services({ saveGame, getSaveActorId: () => "hero-stable", resolveSaveActor: (id) => id === "hero-stable" ? hero : undefined })).createContext(hero, 0, 0);
    ctx.setSaveField("members", [hero, null], "actor", true);
    expect(ctx.getSaveData()).toEqual({ Party: ["hero-stable", null] });
    expect(ctx.getSaveField("members", "actor", true)).toEqual([hero, null]);
  });

  it.each([false, true])("runs compiled visual migration against staging and propagates errors (fail=%s)", async (fail) => {
    const disk = storage();
    const old = new SaveGameService({ projectId: "project", definition, storage: disk });
    old.getSaveData().Coins = 7;
    expect((await old.saveGame()).ok).toBe(true);
    const next = new SaveGameService({ projectId: "project", storage: disk, definition: { ...definition, schemaVersion: 2 } });
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
      ({ id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 } });
    const graph: LogicGraph = { id: "migration", kind: "event", nodes: [node("event", "flow.event.saveMigration"),
      node("read", "saveGame.migrationGetField", { fieldId: "coins", typeId: "int" }),
      node("write", "saveGame.migrationSetField", { fieldId: "coins", typeId: "int" }),
      node("convert", "debug.executeJavaScript", { inputs: [{ name: "old", type: { kind: "int" } }], outputs: [{ name: "next", type: { kind: "int" } }],
        body: fail ? "throw new Error('Cannot migrate');" : "next = old + 5;" })], edges: [
        { id: "run", sourceNodeId: "event", sourcePinId: "execOut", targetNodeId: "convert", targetPinId: "execIn" },
        { id: "read", sourceNodeId: "read", sourcePinId: "value", targetNodeId: "convert", targetPinId: "in_old" },
        { id: "write", sourceNodeId: "convert", sourcePinId: "execOut", targetNodeId: "write", targetPinId: "execIn" },
        { id: "value", sourceNodeId: "convert", sourcePinId: "out_next", targetNodeId: "write", targetPinId: "value" },
      ] };
    const compiled = compileGraph(graph, { registry, assetGuid: "migration" });
    const host = new ScriptHost(services({ saveGame: next }));
    await host.load({ assetGuid: "migration", classId: "Migrator", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints });
    const ctx = host.createContext(new Actor({ classId: "Migrator" }), 0, 0);
    ctx.registerSaveMigration(1, "onSaveMigration");
    const result = await ctx.loadGame();
    expect(result.ok).toBe(!fail);
    expect(ctx.getSaveData()).toEqual({ Coins: fail ? 0 : 12 });
    expect((await old.loadGame()).ok).toBe(true);
    expect(old.getSaveData()).toEqual({ Coins: 7 });
  });
});
