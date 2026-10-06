import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { CommandSourcePreparation, commandSourceGuids } from "./command-source-preparation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const mesh = (id: string): Extract<CommandMessage, { type: "assignMesh" }> => ({ type: "assignMesh", slotId: 7, meshAssetGuid: id });

describe("cold command source preparation", () => {
  it("keeps a previous visual owned until its replacement is prepared and readiness observes assignment", async () => {
    const replacement = deferred<() => void>();
    const released: string[] = [];
    const applied: string[] = [];
    const preparation = new CommandSourcePreparation();
    preparation.setLoader(async ([guid]) => guid === "second" ? replacement.promise : () => { released.push(guid); });
    const apply = (command: CommandMessage) => { if (command.type === "assignMesh") applied.push(command.meshAssetGuid!); };
    preparation.receive(mesh("first"), apply);
    await preparation.whenReady([7]);
    preparation.receive(mesh("second"), apply);
    const ready = preparation.whenReady([7]);
    expect(applied).toEqual(["first"]);
    expect(released).toEqual([]);
    replacement.resolve(() => { released.push("second"); });
    await ready;
    expect(applied).toEqual(["first", "second"]);
    expect(released).toEqual(["first"]);
    preparation.receive({ type: "despawn", slotId: 7, actorGuid: "actor" }, apply);
    expect(released).toEqual(["first", "second"]);
    preparation.dispose();
  });

  it("applies dependent assignments in emission order even when material sources finish first", async () => {
    const model = deferred<() => void>();
    const material = deferred<() => void>();
    const preparation = new CommandSourcePreparation();
    preparation.setLoader(async ([guid]) => guid === "model" ? model.promise : material.promise);
    const applied: string[] = [];
    const apply = (command: CommandMessage) => { applied.push(command.type); };
    preparation.receive(mesh("model"), apply);
    preparation.receive({ type: "assignMaterial", slotId: 7, materialAssetGuid: "material" }, apply);
    material.resolve(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(applied).toEqual([]);
    model.resolve(() => undefined);
    await preparation.whenReady([7]);
    expect(applied).toEqual(["assignMesh", "assignMaterial"]);
    preparation.dispose();
  });

  it("retains failed readiness for observers while leaving the previous visual valid and permits retry", async () => {
    let fail = false;
    const released: string[] = [];
    const applied: string[] = [];
    const preparation = new CommandSourcePreparation();
    preparation.setLoader(async ([guid]) => {
      if (fail) throw new Error("Missing source file");
      return () => { released.push(guid); };
    });
    const apply = (command: CommandMessage) => { if (command.type === "assignMesh") applied.push(command.meshAssetGuid!); };
    preparation.receive(mesh("previous"), apply);
    await preparation.whenReady([7]);
    fail = true;
    preparation.receive(mesh("replacement"), apply);
    await expect(preparation.whenReady([7])).rejects.toThrow("Missing source file");
    await expect(preparation.whenReady([7])).rejects.toThrow("Missing source file");
    expect(applied).toEqual(["previous"]);
    expect(released).toEqual([]);
    fail = false;
    preparation.receive(mesh("replacement"), apply);
    await preparation.whenReady([7]);
    expect(applied).toEqual(["previous", "replacement"]);
    expect(released).toEqual(["previous"]);
    preparation.dispose();
  });

  it("cancels a despawned consumer and releases late preparation without publishing it", async () => {
    const result = deferred<() => void>();
    let signal: AbortSignal | undefined;
    let released = false;
    const applied: string[] = [];
    const preparation = new CommandSourcePreparation();
    preparation.setLoader(async (_guids, options) => { signal = options.signal; return result.promise; });
    const apply = (command: CommandMessage) => { applied.push(command.type); };
    preparation.receive(mesh("model"), apply);
    preparation.receive({ type: "despawn", slotId: 7, actorGuid: "actor" }, apply);
    expect(signal?.aborted).toBe(true);
    result.resolve(() => { released = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(applied).toEqual(["despawn"]);
    expect(released).toBe(true);
    await preparation.whenReady([7]);
    preparation.dispose();
  });

  it("bounds simultaneous source preparations and includes component resources", async () => {
    const first = deferred<() => void>();
    let active = 0;
    let peak = 0;
    const preparation = new CommandSourcePreparation({ concurrency: 1 });
    preparation.setLoader(async ([guid]) => {
      peak = Math.max(peak, ++active);
      if (guid === "first") await first.promise;
      active--;
      return () => undefined;
    });
    preparation.receive(mesh("first"), () => undefined);
    preparation.receive({ ...mesh("second"), slotId: 8 }, () => undefined);
    first.resolve(() => undefined);
    await preparation.whenReady();
    expect(peak).toBe(1);
    expect(commandSourceGuids({ ...mesh("model"), text3d: {
      text: "Label", size: 1, depth: 0.1, color: [1, 1, 1], alignment: "left", fontAssetGuid: "font",
    }, skybox: { size: 10, faces: { px: "texture", py: null, pz: null, nx: null, ny: null, nz: null } } })).toEqual(["font", "model", "texture"]);
    preparation.dispose();
  });

  it("passes exact font modes for cold commands and supersedes an incompatible mode for the same font", async () => {
    const first = deferred<() => void>();
    const received: Array<{ modes: string[]; signal: AbortSignal }> = [];
    const preparation = new CommandSourcePreparation();
    preparation.setLoader(async (_guids, options) => {
      received.push({ modes: [...(options.fontModes?.get("font") ?? [])], signal: options.signal });
      return received.length === 1 ? first.promise : () => undefined;
    });
    const text2d: NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["text2d"]> = {
      text: "Label", fontAssetGuid: "font", renderer: "bitmap", size: 12, color: [1, 1, 1],
      outline: 0, outlineColor: [0, 0, 0], alignment: "left", verticalAlignment: "top",
      bold: false, italic: false, underline: false, wrapWidth: 0, wrapHeight: 0,
    };
    preparation.receive({ type: "assignMesh", slotId: 7, text2d }, () => undefined);
    preparation.receive({ type: "assignMesh", slotId: 7, text2d: { ...text2d, renderer: "msdf" } }, () => undefined);
    first.resolve(() => undefined);
    await preparation.whenReady([7]);
    expect(received.map(value => value.modes)).toEqual([["bitmap"], ["msdf"]]);
    expect(received[0].signal.aborted).toBe(true);
    preparation.dispose();
  });
});
