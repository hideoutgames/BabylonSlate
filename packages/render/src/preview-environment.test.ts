import { mockCubeTextureIO } from "./texture-test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, PBRMaterial, Texture } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import { createMaterialPreviewScene } from "./material-preview";
import { createModelPreviewScene } from "./model-preview";
import {
  PREVIEW_SKYBOX_MESH_NAME,
  installPreviewEnvironment,
} from "./preview-environment";
import { isSkyboxMesh } from "./skybox";
import { RENDERING_GROUP } from "./sorting";

describe("installPreviewEnvironment", () => {
  const handles: Array<{ engine: { dispose: () => void } }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.engine.dispose();
    }
  });

  it("installs the engine default skybox on a material preview scene", () => {
    const handle = createTestEngine();
    mockCubeTextureIO(handle.engine);
    handles.push(handle);
    const host = createMaterialPreviewScene(handle.engine);
    expect(host.scene.getMeshByName(PREVIEW_SKYBOX_MESH_NAME)).toBeNull();

    installPreviewEnvironment(host.scene);

    const skybox = host.scene.getMeshByName(PREVIEW_SKYBOX_MESH_NAME);
    expect(skybox).toBeTruthy();
    expect(isSkyboxMesh(skybox!)).toBe(true);
    expect(skybox!.isPickable).toBe(false);
    expect(skybox!.renderingGroupId).toBe(RENDERING_GROUP.background);
    const material = skybox!.material as PBRMaterial;
    expect(material).toBeInstanceOf(PBRMaterial);
    expect(material.disableLighting).toBe(true);
    expect(material.reflectionTexture?.coordinatesMode).toBe(
      Texture.SKYBOX_MODE,
    );
    host.dispose();
  });

  it("shares one uploaded cube across preview scenes on the same engine", () => {
    const handle = createTestEngine();
    mockCubeTextureIO(handle.engine);
    handles.push(handle);
    const first = createMaterialPreviewScene(handle.engine);
    const second = createModelPreviewScene(handle.engine);

    const firstSkybox = installPreviewEnvironment(first.scene);
    const secondSkybox = installPreviewEnvironment(second.scene);

    const firstTexture = (firstSkybox.material as PBRMaterial)
      .reflectionTexture;
    const secondTexture = (secondSkybox.material as PBRMaterial)
      .reflectionTexture;
    expect(firstTexture).toBeTruthy();
    expect(secondTexture).toBe(firstTexture);

    first.dispose();
    // The shared cube outlives one preview's disposal.
    expect(
      (secondSkybox.material as PBRMaterial).reflectionTexture,
    ).toBe(firstTexture);
    second.dispose();
  });

  it("leaves thumbnail-style transparent hosts without a skybox by default", () => {
    const handle = createTestEngine();
    mockCubeTextureIO(handle.engine);
    handles.push(handle);
    // model-thumbnail builds this host; it never installs the environment.
    const host = createModelPreviewScene(handle.engine, { transparent: true });
    expect(host.scene.meshes.some((mesh) => isSkyboxMesh(mesh))).toBe(false);
    host.dispose();
  });

  it("is not installed by the material preview factory itself", () => {
    const handle = new NullEngine();
    handles.push({ engine: handle });
    const host = createMaterialPreviewScene(handle);
    expect(host.scene.meshes.some((mesh) => isSkyboxMesh(mesh))).toBe(false);
    host.dispose();
  });
});
