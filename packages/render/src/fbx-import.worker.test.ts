import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelImportFile } from "./fbx-conversion";

const convert = vi.hoisted(() =>
  vi.fn<(file: ModelImportFile, sidecars: readonly ModelImportFile[], consumed?: Set<string>) => Promise<Uint8Array>>(),
);
vi.mock("./fbx-conversion", () => ({ convertFbxToGlb: convert }));

type Scope = {
  onmessage: ((event: { data: unknown }) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

let scope: Scope;

/** Load a fresh worker module, whose batch sidecars start empty. */
async function startWorker(): Promise<(data: unknown) => Promise<void>> {
  vi.resetModules();
  await import("./fbx-import.worker");
  return (data) => scope.onmessage!({ data });
}

const file = (name: string): ModelImportFile => ({ name, bytes: new Uint8Array([1]) });

beforeEach(() => {
  scope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  convert.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("FBX import worker", () => {
  it("converts every FBX of a batch against the sidecars it received once", async () => {
    const albedo = file("albedo.png");
    convert.mockImplementation(async (_file, _sidecars, consumed) => {
      consumed?.add("albedo.png");
      return new Uint8Array([7, 8]);
    });
    const receive = await startWorker();
    await receive({ type: "sidecars", sidecars: [albedo] });
    await receive({ type: "convert", file: file("a.fbx") });
    await receive({ type: "convert", file: file("b.fbx") });

    expect(convert.mock.calls.map(([converted, sidecars]) => [converted.name, sidecars])).toEqual([
      ["a.fbx", [albedo]],
      ["b.fbx", [albedo]],
    ]);
    expect(scope.postMessage).toHaveBeenCalledTimes(2);
  });

  it("moves the converted bytes to the editor instead of cloning them", async () => {
    const glb = new Uint8Array([1, 2, 3]);
    convert.mockResolvedValue(glb);
    const receive = await startWorker();
    await receive({ type: "convert", file: file("a.fbx") });

    const [message, transfer] = scope.postMessage.mock.calls[0]!;
    expect(message).toEqual({ bytes: glb, consumedSidecars: [] });
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(glb.buffer);
  });

  it("replies with the failure and stays ready for the next FBX", async () => {
    convert.mockRejectedValueOnce(new Error("Missing FBX texture: albedo.png.")).mockResolvedValueOnce(new Uint8Array([5]));
    const receive = await startWorker();
    await receive({ type: "convert", file: file("bad.fbx") });
    await receive({ type: "convert", file: file("good.fbx") });

    expect(scope.postMessage.mock.calls[0]).toEqual([{ error: "Missing FBX texture: albedo.png." }]);
    expect(scope.postMessage.mock.calls[1]![0]).toMatchObject({ bytes: new Uint8Array([5]) });
  });
});
