import { Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createWidgetComponent,
} from "@babylonslate/core";
import { createDefaultUserInterface } from "@babylonslate/ui-runtime";
import { createTestEngine } from "./create-null-engine";
import {
  actorVisualFingerprint,
  applySceneToBabylonScene,
  editorMeshName,
  helperBillboardIconOf,
} from "./scene-loader";

describe("WidgetComponent editor mesh", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      try {
        handle?.scene.dispose();
      } catch {
        /* NullEngine ADT */
      }
      handle?.engine.dispose();
    }
  });

  it("is a surface visual, not a helper billboard", () => {
    const actor = createActor("sign", "Sign", {
      components: [createWidgetComponent("widget-comp")],
    });
    expect(helperBillboardIconOf(actor)).toBeNull();
  });

  it("builds an editor plane and fingerprints UI, two-sided, and size edits", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const actor = createActor("sign", "Sign", {
      components: [createWidgetComponent("widget-comp")],
    });
    const sceneData = { ...createDefaultScene(), actors: [actor] };
    applySceneToBabylonScene(handle.scene, sceneData);
    const mesh = handle.scene.getMeshByName(editorMeshName("sign"));
    expect(mesh).toBeInstanceOf(Mesh);
    expect((mesh?.metadata as { widget?: boolean } | null)?.widget).toBe(true);
    expect(mesh?.sideOrientation).toBe(Mesh.FRONTSIDE);

    const before = actorVisualFingerprint(actor);
    actor.components[0]!.properties.twoSided = true;
    expect(actorVisualFingerprint(actor)).not.toBe(before);
    actor.components[0]!.properties.uiAssetGuid = "hud-1";
    expect(actorVisualFingerprint(actor)).not.toBe(before);
    actor.components[0]!.properties.width = 2;
    expect(actorVisualFingerprint(actor)).not.toBe(before);
  });

  it("attaches a paint-only mesh GUI when the UserInterface document is in assets", () => {
    if (typeof globalThis.OffscreenCanvas === "undefined") {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return { canvas: this, fillRect() {}, clearRect() {}, fillText() {} };
        }
      };
    }
    const handle = createTestEngine();
    handles.push(handle);
    const actor = createActor("sign", "Sign", {
      components: [
        {
          ...createWidgetComponent("widget-comp"),
          properties: {
            ...createWidgetComponent("widget-comp").properties,
            uiAssetGuid: "panel-ui",
            twoSided: true,
          },
        },
      ],
    });
    const doc = createDefaultUserInterface("Panel");
    doc.viewportLayer = false;
    applySceneToBabylonScene(
      handle.scene,
      { ...createDefaultScene(), actors: [actor] },
      {
        uiDocuments: new Map([["panel-ui", doc]]),
      },
    );
    const mesh = handle.scene.getMeshByName(editorMeshName("sign"));
    expect(mesh?.material?.backFaceCulling).toBe(false);
    expect(mesh?.sideOrientation).toBe(Mesh.DOUBLESIDE);
  });
});
