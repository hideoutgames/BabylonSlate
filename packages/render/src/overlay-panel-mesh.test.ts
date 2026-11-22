import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { isUnlitMaterial } from "./unlit-material";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./test-support/test-engine";
import { createOverlayPanelMesh } from "./overlay-panel-mesh";

describe("createOverlayPanelMesh", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("draws a Material source only from a User Interface Material, else its unlit look", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const materials = new Map(["ui", "surface"].map((domain) =>
      [domain, Object.assign(new StandardMaterial(domain, handle.scene), { metadata: { materialDomain: domain } })]));
    const panel = (materialGuid: string) => createOverlayPanelMesh(handle.scene, materialGuid, {
      source: "material", textureGuid: null, materialGuid,
      marginLeft: 0.1, marginRight: 0.1, marginTop: 0.1, marginBottom: 0.1, hitTest: "ignore",
    }, { pixelsPerUnit: 100, resolveMaterial: (guid) => materials.get(guid) ?? null });
    expect(panel("ui").material).toBe(materials.get("ui"));
    expect(isUnlitMaterial(panel("surface").material)).toBe(true);
  });

  it.each([[1, 1], [4, 2], [0.3, 5]])("spans a Material-source panel of %s x %s with one linear UV, whatever its margins", (destWidth, destHeight) => {
    // A User Interface Material reads the panel as one element: UV is the position across the unit quad.
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createOverlayPanelMesh(handle.scene, "panel", {
      source: "material", textureGuid: null, materialGuid: null,
      marginLeft: 0.3, marginRight: 0.1, marginTop: 0.45, marginBottom: 0.2, hitTest: "ignore", destWidth, destHeight,
    }, { pixelsPerUnit: 100 });
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
    expect(uvs.length).toBeGreaterThan(8);
    for (let vertex = 0; vertex < uvs.length / 2; vertex += 1) {
      expect(uvs[vertex * 2]!).toBeCloseTo(positions[vertex * 3]! + 0.5, 6);
      expect(uvs[vertex * 2 + 1]!).toBeCloseTo(positions[vertex * 3 + 1]! + 0.5, 6);
    }
  });

  it("keeps unscaled 9-slice corner UVs on a 1x1 dest", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createOverlayPanelMesh(
      handle.scene,
      "panel",
      {
        source: "texture",
        textureGuid: "tex-1",
        materialGuid: null,
        marginLeft: 0.1,
        marginRight: 0.1,
        marginTop: 0.1,
        marginBottom: 0.1,
        hitTest: "ignore",
      },
      { pixelsPerUnit: 100, textureBytes: new Map([["tex-1", new Uint8Array(4)]] ) },
    );
    expect(isUnlitMaterial(mesh.material)).toBe(true);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind) ?? [];
    const uniqueU = [...new Set(uvs.filter((_, index) => index % 2 === 0))].sort(
      (a, b) => a - b,
    );
    expect(uniqueU[0]).toBeCloseTo(0);
    expect(uniqueU[1]).toBeCloseTo(0.1);
    expect(uniqueU[2]).toBeCloseTo(0.9);
    expect(uniqueU[3]).toBeCloseTo(1);
    expect(mesh.getTotalVertices()).toBe(36);
  });

  it("builds a unit quad whose corners stay margin/ppu after actor scale", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createOverlayPanelMesh(
      handle.scene,
      "panel",
      {
        source: "texture",
        textureGuid: "tex-1",
        materialGuid: null,
        marginLeft: 0.1,
        marginRight: 0.1,
        marginTop: 0.1,
        marginBottom: 0.1,
        hitTest: "ignore",
        destWidth: 4,
        destHeight: 2,
      },
      { pixelsPerUnit: 100, textureBytes: new Map([["tex-1", new Uint8Array(4)]] ) },
    );
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
    const widths = new Set<number>();
    for (let i = 0; i < positions.length; i += 12) {
      widths.add(Number((positions[i + 3]! - positions[i]!).toFixed(6)));
    }
    expect([...widths].sort((a, b) => a - b)[0]).toBeCloseTo(0.025);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind) ?? [];
    const uniqueU = [...new Set(uvs.filter((_, index) => index % 2 === 0))].sort(
      (a, b) => a - b,
    );
    expect(uniqueU[0]).toBeCloseTo(0);
    expect(uniqueU[1]).toBeCloseTo(0.1);
    expect(uniqueU[2]).toBeCloseTo(0.9);
    expect(uniqueU[3]).toBeCloseTo(1);
  });
});
