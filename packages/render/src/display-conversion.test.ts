import { afterEach, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { DisplayConversion } from "./display-conversion";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const conversion = new DisplayConversion(engine);
  disposers.push(() => { conversion.dispose(); scene.dispose(); engine.dispose(); });
  const source = new RenderTargetTexture("source", 8, scene);
  /** The defines of the Effect `draw` would draw with now. */
  const drawn = () => {
    const enable = vi.spyOn(engine, "enableEffect");
    conversion.draw(source);
    const wrapper = enable.mock.calls.at(-1)![0] as { effect: { defines: string } };
    enable.mockRestore();
    return wrapper.effect.defines;
  };
  return { engine, scene, conversion, source, drawn };
}

it("encodes a Scene Linear source for display and copies any other, with a configuration of its own", async () => {
  const { scene, conversion, drawn } = fixture();
  scene.imageProcessingConfiguration.applyByPostProcess = true;
  await vi.waitFor(() => expect(conversion.ready(true)).toBe(true));
  // The stock shader encodes and clamps a linear input, and with nothing else enabled does nothing to any other.
  expect(drawn()).toContain("#define FROMLINEARSPACE");
  expect(drawn()).not.toContain("#define IMAGEPROCESSING\n");
  await vi.waitFor(() => expect(conversion.ready(false)).toBe(true));
  expect(drawn()).not.toContain("#define FROMLINEARSPACE");
  expect(drawn()).not.toContain("#define IMAGEPROCESSING\n");
  // The thin pass sets and resets `applyByPostProcess` on the configuration it owns: never the Scene's.
  conversion.dispose();
  expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(true);
});

it("draws its source over the whole bound target, unblended", async () => {
  const { engine, conversion, source } = fixture();
  await vi.waitFor(() => expect(conversion.ready(true)).toBe(true));
  const viewport = vi.spyOn(engine, "setViewport");
  const alpha = vi.spyOn(engine, "setAlphaMode");
  const colour = vi.spyOn(engine, "setColorWrite");
  const draws = vi.spyOn(engine, "drawElementsType");
  const sampled: unknown[] = [];
  vi.spyOn(engine, "setTexture").mockImplementation((_channel, _uniform, texture) => { sampled.push(texture); });
  const floats = vi.spyOn(Effect.prototype, "setFloat2");
  conversion.draw(source);
  // The post-process vertex stage scales its quad by a bound value.
  expect(floats).toHaveBeenCalledWith("scale", 1, 1);
  expect(viewport.mock.calls.at(-1)![0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  expect(alpha.mock.calls.at(-1)![0]).toBe(0);
  expect(colour.mock.calls.at(-1)![0]).toBe(true);
  expect(sampled).toEqual([source]);
  expect(draws).toHaveBeenCalledTimes(1);
});

it("keeps one compiled pass while its source's form stays the same", async () => {
  const { engine, conversion } = fixture();
  await vi.waitFor(() => expect(conversion.ready(true)).toBe(true));
  const created = vi.spyOn(engine, "createEffect");
  expect(conversion.ready(true)).toBe(true);
  expect(created).not.toHaveBeenCalled();
});
