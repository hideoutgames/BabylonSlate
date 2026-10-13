import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelImportFile } from "./fbx-conversion";

const convert = vi.hoisted(() =>
  vi.fn<(file: ModelImportFile, sidecars: readonly ModelImportFile[], consumed?: Set<string>) => Promise<Uint8Array>>(),
);
vi.mock("./fbx-conversion", () => ({ convertFbxToGlb: convert }));

type Scope = {
  onmessage: ((event: { data: unknown }) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
};

let scope: Scope;

/** Raise an uncaught error in the worker and report whether the worker cancelled it, keeping it from the editor. */
function raiseUncaughtError(): boolean {
  const [, listener] = scope.addEventListener.mock.calls.find(([type]) => type === "error")!;
  const preventDefault = vi.fn();
  listener({ message: "late callback failed", preventDefault });
  return preventDefault.mock.calls.length > 0;
}

/** Load a fresh worker module, whose batch sidecars start empty. */
async function startWorker(): Promise<(data: unknown) => Promise<void>> {
  vi.resetModules();
  await import("./fbx-import.worker");
  return (data) => scope.onmessage!({ data });
}

const file = (name: string): ModelImportFile => ({ name, bytes: new Uint8Array([1]) });

beforeEach(() => {
  scope = { onmessage: null, postMessage: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal("self", scope);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  convert.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("keeps an uncaught error from a leftover callback away from the editor once the conversion has replied or failed", async () => {
    convert.mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(new Error("bad"));
    const receive = await startWorker();

    await receive({ type: "convert", file: file("a.fbx") });
    expect(raiseUncaughtError()).toBe(true);
    await receive({ type: "convert", file: file("b.fbx") });
    expect(raiseUncaughtError()).toBe(true);
  });

  it("lets an uncaught error during a conversion reach the editor, which is otherwise left waiting for a reply", async () => {
    let finish!: (glb: Uint8Array) => void;
    convert.mockReturnValue(new Promise<Uint8Array>((resolve) => (finish = resolve)));
    const receive = await startWorker();
    const converting = receive({ type: "convert", file: file("a.fbx") });

    expect(raiseUncaughtError()).toBe(false);
    finish(new Uint8Array([1]));
    await converting;
  });
});
