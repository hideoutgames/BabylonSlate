import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import {
  bindInterfaceMaterialImage,
  createInterfaceMaterialPresenter,
} from "./interface-material-presenter";
import { Image } from "@babylonjs/gui/2D/controls/image";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function hostScene(): Scene {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => {
    scene.dispose();
    engine.dispose();
  });
  return scene;
}

describe("createInterfaceMaterialPresenter", () => {
  it("sizes a blit canvas to the widget rect and honors resize/dispose", () => {
    const scene = hostScene();
    const presenter = createInterfaceMaterialPresenter({
      scene,
      document: createDefaultMaterialDocument("Glow", "interface"),
      assetGuid: "mat-glow",
      width: 128,
      height: 64,
    });
    disposers.push(() => presenter.dispose());
    expect(presenter.canvas.width).toBe(128);
    expect(presenter.canvas.height).toBe(64);
    presenter.resize(32, 16);
    expect(presenter.canvas.width).toBe(32);
    expect(presenter.canvas.height).toBe(16);
    expect(() => presenter.dispose()).not.toThrow();
  });
});

describe("bindInterfaceMaterialImage", () => {
  it("drives a GUI Image from the presenter canvas", () => {
    const scene = hostScene();
    const presenter = createInterfaceMaterialPresenter({
      scene,
      document: createDefaultMaterialDocument("Glow", "interface"),
      assetGuid: "mat-glow",
      width: 8,
      height: 8,
    });
    disposers.push(() => presenter.dispose());
    const image = new Image("fx");
    bindInterfaceMaterialImage(image, presenter.canvas);
    expect(image.domImage).toBe(presenter.canvas);
  });
});
