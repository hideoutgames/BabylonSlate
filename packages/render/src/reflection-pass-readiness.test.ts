import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { expect, it, vi } from "vitest";
import { reflectionDrewWhole } from "./reflection-pass-readiness";

const mesh = (name: string) => ({ name }) as unknown as AbstractMesh;

/** A pass's target: what it lists, and what it answers when asked whether every listed mesh is ready. */
function pass(list: AbstractMesh[] | null, ready = true) {
  const asked = vi.fn(() => ready);
  const texture = { renderList: list, isReadyForRendering: asked } as unknown as RenderTargetTexture;
  return { texture, asked, answer: (value: boolean) => asked.mockImplementation(() => value) };
}

it("asks the target once for the meshes a draw listed, then not while the Scene's readiness stands", () => {
  const wall = mesh("wall"), mover = mesh("mover");
  const { texture, asked } = pass([wall, mover]);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(1);
  // The same meshes, and fewer of them as the view turns: known ready.
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  texture.renderList = [mover];
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(1);
});

it("asks again for a mesh new to the pass, and after the Scene's readiness was marked", () => {
  const wall = mesh("wall"), mover = mesh("mover"), spawned = mesh("spawned");
  const { texture, asked } = pass([wall, mover]);
  reflectionDrewWhole(texture, 7, false);
  // A mesh the pass never drew may have no ready variant for it yet.
  texture.renderList = [wall, mover, spawned];
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(2);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(2);
  // A marked Scene: any of them may draw with another variant.
  expect(reflectionDrewWhole(texture, 8, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(3);
});

it("keeps asking while a draw left a mesh out, and remembers nothing from it", () => {
  const wall = mesh("wall");
  const { texture, asked, answer } = pass([wall], false);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(false);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(false);
  expect(asked).toHaveBeenCalledTimes(2);
  answer(true);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(3);
});

it("takes the caller's own answer for a first draw without asking, and remembers its meshes", () => {
  const wall = mesh("wall");
  const { texture, asked } = pass([wall], false);
  expect(reflectionDrewWhole(texture, 7, true)).toBe(true);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).not.toHaveBeenCalled();
});

it("always asks a target that lists every mesh of the Scene", () => {
  const { texture, asked } = pass(null);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(reflectionDrewWhole(texture, 7, false)).toBe(true);
  expect(asked).toHaveBeenCalledTimes(2);
});
