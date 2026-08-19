import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKYBOX_FACE_KEYS } from "@babylonslate/core";
import {
  SKYBOX_CREATOR_COMPASS_TO_BABYLON,
  SKYBOX_CREATOR_NET_ASPECT,
  SKYBOX_CREATOR_NET_CELLS,
  SKYBOX_CREATOR_NET_COLS,
  SKYBOX_CREATOR_NET_ROWS,
  createDefaultSkyboxCreatorPayload,
  createSkyboxFaceTextureResult,
  defaultSkyboxCreatorSourcePlacement,
  fitSourceIntoSkyboxNet,
  letterboxSize,
  normalizeSkyboxCreatorPayload,
  resizeSkyboxCreatorSourcePlacement,
  skyboxCreatorAssetDependencies,
  skyboxCreatorFaceRelativePath,
  planSkyboxCreatorFaceWrites,
} from "./skybox-creator-payload";

function pixel(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
): number[] {
  const index = (y * width + x) * 4;
  return [...rgba.subarray(index, index + 4)];
}

function fill(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const index = (y * width + x) * 4;
  rgba.set(color, index);
}

describe("SkyboxCreator payload", () => {
  it("seeds an empty source and empty generated faces", () => {
    expect(createDefaultSkyboxCreatorPayload()).toEqual({
      sourceTextureGuid: null,
      sourcePlacement: null,
      generatedFaces: {
        px: null,
        py: null,
        pz: null,
        nx: null,
        ny: null,
        nz: null,
      },
    });
  });

  it("normalizes missing and invalid fields", () => {
    expect(normalizeSkyboxCreatorPayload({})).toEqual(
      createDefaultSkyboxCreatorPayload(),
    );
    expect(
      normalizeSkyboxCreatorPayload({
        sourceTextureGuid: "  tex-1  ",
        generatedFaces: { pz: "front-1", junk: "nope" },
      }),
    ).toEqual({
      sourceTextureGuid: "tex-1",
      sourcePlacement: null,
      generatedFaces: {
        px: null,
        py: null,
        pz: "front-1",
        nx: null,
        ny: null,
        nz: null,
      },
    });
    expect(
      normalizeSkyboxCreatorPayload({
        sourcePlacement: { x: -0.25, y: 0.1, width: 1.5, height: 0.8 },
      }).sourcePlacement,
    ).toEqual({ x: -0.25, y: 0.1, width: 1.5, height: 0.8 });
    expect(
      normalizeSkyboxCreatorPayload({
        sourcePlacement: { x: "nope", y: 0, width: 1, height: 1 },
      }).sourcePlacement,
    ).toBeNull();
  });

  it("collects source and generated face guids as header dependencies", () => {
    expect(skyboxCreatorAssetDependencies("Texture", {})).toEqual([]);
    expect(
      skyboxCreatorAssetDependencies("SkyboxCreator", {
        sourceTextureGuid: "src-1",
        generatedFaces: { px: "px-1", pz: "src-1", ny: "ny-1" },
      }),
    ).toEqual(["ny-1", "px-1", "src-1"]);
  });

  it("writes generated faces next to the helper document", () => {
    expect(
      skyboxCreatorFaceRelativePath(
        "assets/skies/Day.skyboxcreator.babasset",
        "px",
      ),
    ).toBe("assets/skies/Day_px.babasset");
    expect(skyboxCreatorFaceRelativePath("Day.skyboxcreator.babasset", "nz")).toBe(
      "Day_nz.babasset",
    );
  });

  it("reuses previous face guids and paths when they still exist", () => {
    const writes = planSkyboxCreatorFaceWrites({
      helperPath: "assets/Day.skyboxcreator.babasset",
      generatedFaces: {
        px: "old-px",
        py: null,
        pz: null,
        nx: null,
        ny: null,
        nz: "missing-nz",
      },
      existingByGuid: new Map([
        ["old-px", { path: "assets/Day_px.babasset" }],
      ]),
      occupiedPaths: new Set(["assets/Day_px.babasset", "assets/Day_py.babasset"]),
      newGuid: (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
    });
    expect(writes.find((row) => row.key === "px")).toEqual({
      key: "px",
      path: "assets/Day_px.babasset",
      guid: "old-px",
      replace: true,
    });
    expect(writes.find((row) => row.key === "py")).toEqual({
      key: "py",
      path: "assets/Day_py_1.babasset",
      guid: "new-1",
      replace: false,
    });
    expect(writes.find((row) => row.key === "nz")).toEqual({
      key: "nz",
      path: "assets/Day_nz.babasset",
      guid: "new-5",
      replace: false,
    });
  });

  it("builds an uncompressed skybox Texture import result", () => {
    const png = Uint8Array.of(1, 2, 3);
    const result = createSkyboxFaceTextureResult({
      name: "Day_px",
      guid: "face-px",
      pngBytes: png,
    });
    expect(result.type).toBe("Texture");
    expect(result.name).toBe("Day_px");
    expect(result.guid).toBe("face-px");
    expect(result.payload).toEqual({ usage: "skybox" });
    expect(result.chunks).toEqual([
      {
        id: "pixels",
        kind: "pixels",
        mime: "image/png",
        data: png,
      },
    ]);
  });
});

describe("SkyboxCreator cubemap net", () => {
  it("uses a 4 by 3 template net and remaps compass labels to Babylon faces", () => {
    expect(SKYBOX_CREATOR_NET_COLS).toBe(4);
    expect(SKYBOX_CREATOR_NET_ROWS).toBe(3);
    expect(SKYBOX_CREATOR_NET_CELLS).toEqual({
      up: { col: 1, row: 0 },
      left: { col: 0, row: 1 },
      front: { col: 1, row: 1 },
      right: { col: 2, row: 1 },
      back: { col: 3, row: 1 },
      down: { col: 1, row: 2 },
    });
    expect(SKYBOX_CREATOR_COMPASS_TO_BABYLON).toEqual({
      front: "pz",
      back: "nz",
      right: "px",
      left: "nx",
      up: "py",
      down: "ny",
    });
  });

  it("crops a 4 by 3 atlas into Babylon faces without forcing 512", () => {
    const width = 4;
    const height = 3;
    const rgba = new Uint8Array(width * height * 4);
    const colors = {
      up: [10, 0, 0, 255],
      left: [0, 20, 0, 255],
      front: [0, 0, 30, 255],
      right: [40, 40, 0, 255],
      back: [50, 0, 50, 255],
      down: [0, 60, 60, 255],
    } as const;
    fill(rgba, width, 1, 0, colors.up);
    fill(rgba, width, 0, 1, colors.left);
    fill(rgba, width, 1, 1, colors.front);
    fill(rgba, width, 2, 1, colors.right);
    fill(rgba, width, 3, 1, colors.back);
    fill(rgba, width, 1, 2, colors.down);

    const sliced = fitSourceIntoSkyboxNet(rgba, width, height);
    expect(sliced.faceSize).toBe(1);
    expect(sliced.netWidth).toBe(4);
    expect(sliced.netHeight).toBe(3);
    expect(SKYBOX_FACE_KEYS.map((key) => key)).toEqual([
      "px",
      "py",
      "pz",
      "nx",
      "ny",
      "nz",
    ]);
    expect(pixel(sliced.faces.px.rgba, 1, 0, 0)).toEqual([...colors.right]);
    expect(pixel(sliced.faces.py.rgba, 1, 0, 0)).toEqual([...colors.up]);
    expect(pixel(sliced.faces.pz.rgba, 1, 0, 0)).toEqual([...colors.front]);
    expect(pixel(sliced.faces.nx.rgba, 1, 0, 0)).toEqual([...colors.left]);
    expect(pixel(sliced.faces.ny.rgba, 1, 0, 0)).toEqual([...colors.down]);
    expect(pixel(sliced.faces.nz.rgba, 1, 0, 0)).toEqual([...colors.back]);
  });

  it("letterboxes a non-net source so the whole image fits", () => {
    const width = 8;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba.set([200, 0, 0, 255], i);
    }

    const sliced = fitSourceIntoSkyboxNet(rgba, width, height);
    expect(sliced.faceSize).toBe(1);
    expect(sliced.dest).toEqual({ x: 0, y: 1, width: 4, height: 1 });
    expect(pixel(sliced.faces.py.rgba, 1, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(sliced.faces.ny.rgba, 1, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(sliced.faces.px.rgba, 1, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(pixel(sliced.faces.pz.rgba, 1, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(pixel(sliced.faces.nx.rgba, 1, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(pixel(sliced.faces.nz.rgba, 1, 0, 0)).toEqual([200, 0, 0, 255]);
  });

  it("derives face size from the source instead of locking to 512", () => {
    const width = 8;
    const height = 6;
    const rgba = new Uint8Array(width * height * 4);
    const sliced = fitSourceIntoSkyboxNet(rgba, width, height);
    expect(sliced.faceSize).toBe(2);
    expect(sliced.faces.py.size).toBe(2);
    expect(sliced.faces.py.rgba.byteLength).toBe(2 * 2 * 4);
  });

  it("keeps a 4 by 3 net of square faces, matching engine default 512 cube faces", () => {
    expect(SKYBOX_CREATOR_NET_ASPECT).toBe(4 / 3);
    expect(SKYBOX_CREATOR_NET_COLS / SKYBOX_CREATOR_NET_ROWS).toBe(
      SKYBOX_CREATOR_NET_ASPECT,
    );
    const sliced = fitSourceIntoSkyboxNet(new Uint8Array(8 * 6 * 4), 8, 6);
    expect(sliced.netWidth / sliced.netHeight).toBe(4 / 3);
    for (const key of SKYBOX_FACE_KEYS) {
      expect(sliced.faces[key].size).toBe(sliced.faceSize);
      expect(sliced.faces[key].rgba.byteLength).toBe(
        sliced.faceSize * sliced.faceSize * 4,
      );
    }
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const png = new Uint8Array(
      readFileSync(join(repoRoot, "engine-content/skybox/px.png")),
    );
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(512);
    expect(view.getUint32(20)).toBe(512);
  });

  it("letterboxes a 4 by 3 net into wide and tall hosts so cells stay square", () => {
    expect(letterboxSize(800, 300)).toEqual({
      width: 400,
      height: 300,
      x: 200,
      y: 0,
    });
    expect(letterboxSize(400, 600)).toEqual({
      width: 400,
      height: 300,
      x: 0,
      y: 150,
    });
    expect(letterboxSize(400, 300)).toEqual({
      width: 400,
      height: 300,
      x: 0,
      y: 0,
    });
  });

  it("contain-fits source placement onto the net by default", () => {
    const wide = defaultSkyboxCreatorSourcePlacement(8, 2);
    expect(wide.x).toBe(0);
    expect(wide.width).toBe(1);
    expect(wide.height).toBeCloseTo(1 / 3);
    expect(wide.y).toBeCloseTo(1 / 3);
    expect(defaultSkyboxCreatorSourcePlacement(4, 3)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("samples an authored placement so a pixel can land in a different compass face", () => {
    const width = 8;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba.set([200, 10, 10, 255], i);
    }
    const contain = fitSourceIntoSkyboxNet(rgba, width, height);
    expect(pixel(contain.faces.py.rgba, contain.faceSize, 0, 0)).toEqual([
      0, 0, 0, 255,
    ]);
    expect(pixel(contain.faces.pz.rgba, contain.faceSize, 0, 0)).toEqual([
      200, 10, 10, 255,
    ]);
    const upOnly = {
      x: 1 / 4,
      y: 0,
      width: 1 / 4,
      height: 1 / 3,
    };
    const sliced = fitSourceIntoSkyboxNet(rgba, width, height, upOnly);
    expect(pixel(sliced.faces.py.rgba, sliced.faceSize, 0, 0)).toEqual([
      200, 10, 10, 255,
    ]);
    expect(pixel(sliced.faces.pz.rgba, sliced.faceSize, 0, 0)).toEqual([
      0, 0, 0, 255,
    ]);
  });

  it("omitted placement matches contain-fit", () => {
    const rgba = new Uint8Array(8 * 2 * 4);
    rgba.fill(180);
    const auto = fitSourceIntoSkyboxNet(rgba, 8, 2);
    const explicit = fitSourceIntoSkyboxNet(
      rgba,
      8,
      2,
      defaultSkyboxCreatorSourcePlacement(8, 2),
    );
    expect(explicit.dest).toEqual(auto.dest);
    expect([...explicit.faces.pz.rgba]).toEqual([...auto.faces.pz.rgba]);
  });

  it("moves and resizes source placement without clamping onto the net", () => {
    const start = { x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(
      resizeSkyboxCreatorSourcePlacement(
        start,
        "move",
        { x: -0.2, y: 0.1 },
        { x: 0, y: 0 },
      ),
    ).toEqual({ x: -0.2, y: 0.1, width: 0.5, height: 0.5 });
    expect(
      resizeSkyboxCreatorSourcePlacement(
        start,
        "se",
        { x: 0.8, y: 0.9 },
        { x: 0.5, y: 0.5 },
      ),
    ).toEqual({ x: 0, y: 0, width: 0.8, height: 0.9 });
  });
});
