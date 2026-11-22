import { expect, it } from "vitest";
import { gltfGeometryDecodersReady } from "./gltf-geometry-decoders";
import { cookComplexCollision } from "./mesh-collision";
import { meshoptBoxGlb } from "./test-support/meshopt-gltf";

// Its own file: the decoder loads once per module graph, and this test needs one that has not loaded it yet.
it("reports meshopt geometry cooked before the decoder loaded as a problem, and cooks it once it has", async () => {
  const required = await meshoptBoxGlb("required");
  expect(cookComplexCollision(required, null)).toEqual({
    mesh: null, problem: expect.stringMatching(/meshopt-compressed .*the meshopt decoder has not loaded/),
  });
  // An optional extension's uncompressed fallback needs no decoder.
  expect(cookComplexCollision(await meshoptBoxGlb("optional-with-fallback"), null).mesh?.indices).toHaveLength(36);
  await gltfGeometryDecodersReady();
  const { mesh, problem } = cookComplexCollision(required, null);
  expect(problem).toBeNull();
  expect(Array.from(mesh!.positions)).toEqual([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  expect(mesh!.indices).toHaveLength(36);
});
