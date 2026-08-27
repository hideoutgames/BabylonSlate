import { StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
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
        marginLeft: 10,
        marginRight: 10,
        marginTop: 10,
        marginBottom: 10,
        hitTest: "ignore",
      },
      { pixelsPerUnit: 100, textureBytes: new Map([["tex-1", new Uint8Array(4)]] ) },
    );
    expect((mesh.material as StandardMaterial).disableLighting).toBe(true);
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
        marginLeft: 10,
        marginRight: 10,
        marginTop: 10,
        marginBottom: 10,
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
