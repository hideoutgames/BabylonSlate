import { unwrapBakeGeometry } from "@babylonslate/render/bake-uv-atlas";
import { bakeLightingPrototype } from "@babylonslate/render/bake-provider-prototype";
import { bakeGeometryFixture } from "@babylonslate/test-kit/baked-geometry-fixtures";
import { remapBakeGeometry } from "@babylonslate/assets";
import type { BakeGeometrySource } from "@babylonslate/core";

function cubeSource(): BakeGeometrySource {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1,
    -1, 1, 1,
  ]);
  return {
    vertexCount: 8,
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0,
      4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ]),
    attributes: [
      {
        name: "position",
        components: 3,
        componentType: "f32",
        normalized: false,
        data: new Uint8Array(positions.buffer),
      },
    ],
  };
}

function cubeChartGaps(
  indices: Uint32Array,
  uv: Float32Array,
  width: number,
  height: number,
) {
  const parent = Array.from({ length: uv.length / 2 }, (_, index) => index);
  const root = (index: number): number =>
    parent[index] === index ? index : (parent[index] = root(parent[index]!));
  for (let index = 0; index < indices.length; index += 3) {
    parent[root(indices[index + 1]!)] = root(indices[index]!);
    parent[root(indices[index + 2]!)] = root(indices[index]!);
  }
  const charts = new Map<number, number[]>();
  for (const vertex of indices) {
    const values = charts.get(root(vertex)) ?? [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ];
    const x = uv[vertex * 2]! * width,
      y = uv[vertex * 2 + 1]! * height;
    values[0] = Math.min(values[0]!, x);
    values[1] = Math.min(values[1]!, y);
    values[2] = Math.max(values[2]!, x);
    values[3] = Math.max(values[3]!, y);
    charts.set(root(vertex), values);
  }
  const boxes = [...charts.values()];
  let minimum = Infinity;
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const first = boxes[a]!,
        second = boxes[b]!;
      minimum = Math.min(
        minimum,
        Math.hypot(
          Math.max(0, first[0]! - second[2]!, second[0]! - first[2]!),
          Math.max(0, first[1]! - second[3]!, second[1]! - first[3]!),
        ),
      );
    }
  return { chartCount: charts.size, minimumChartGap: minimum };
}

/** Real worker/WASM and numeric transport, loaded only by the test-build entry. */
export async function runBakeUvProof() {
  const { source } = bakeGeometryFixture();
  const phases: string[] = [];
  const abort = new AbortController();
  let cancelled = false;
  try {
    await unwrapBakeGeometry(source, {
      resolution: 32,
      paddingTexels: 2,
      signal: abort.signal,
      onProgress: (progress) => {
        phases.push(progress.phase);
        if (progress.phase === "unwrapping" && progress.progress > 0)
          abort.abort();
      },
    });
  } catch (error) {
    cancelled = error instanceof Error && error.name === "AbortError";
  }
  const generated = await unwrapBakeGeometry(source, {
    resolution: 32,
    paddingTexels: 2,
  });
  const cube = await unwrapBakeGeometry(cubeSource(), {
    resolution: 64,
    paddingTexels: 2,
  });
  const gaps = cubeChartGaps(
    cube.topology.indices,
    cube.topology.uv2,
    cube.width,
    cube.height,
  );
  const remapped = remapBakeGeometry(source, generated.topology);
  const position = remapped.attributes.find(
    (attribute) => attribute.name === "position",
  )!;
  const positions = new Float32Array(generated.topology.indices.length * 3);
  const uv2 = new Float32Array(generated.topology.indices.length * 2);
  const view = new DataView(position.data.buffer);
  generated.topology.indices.forEach((vertex, corner) => {
    for (let axis = 0; axis < 3; axis++)
      positions[corner * 3 + axis] = view.getFloat32(
        (vertex * 3 + axis) * 4,
        true,
      );
    for (let axis = 0; axis < 2; axis++)
      uv2[corner * 2 + axis] = generated.topology.uv2[vertex * 2 + axis]!;
  });
  const baked = await bakeLightingPrototype({
    meshes: [
      {
        positions,
        uv2,
        material: { kind: "diffuse", albedo: [0.1, 0.3, 0.7] },
      },
    ],
    lights: [
      { kind: "point", position: [0, 2, 0], color: [1, 1, 1], intensity: 4 },
    ],
    mode: "direct",
    size: 32,
    samples: 1,
    bounces: 2,
  });
  let covered = 0;
  let finite = true;
  let minimum = Infinity;
  let maximum = 0;
  for (let offset = 0; offset < baked.irradiance.length; offset += 4) {
    if (!baked.irradiance[offset + 3]) continue;
    covered++;
    const value = baked.irradiance[offset]!;
    finite &&= Number.isFinite(value);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return {
    cancelled,
    phases,
    width: generated.width,
    height: generated.height,
    ...gaps,
    cubeVertices: cube.topology.originalVertices.length,
    indices: [...generated.topology.indices],
    originalVertices: [...generated.topology.originalVertices],
    uv2: [...generated.topology.uv2],
    sourceUnchanged: source.vertexCount === 4 && source.attributes.length === 3,
    preservedCustom: [
      ...remapped.attributes.find((attribute) => attribute.name === "custom")!
        .data,
    ],
    covered,
    finite,
    minimum,
    maximum,
  };
}
