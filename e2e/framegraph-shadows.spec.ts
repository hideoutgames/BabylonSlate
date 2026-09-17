import { expect, test } from "@playwright/test";
import type { runFrameGraphShadowProof } from "../apps/editor/src/testing/framegraph-shadow-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const configurations = [
  ...(["webgl2", "webgpu"] as const).flatMap((backend) =>
    (["backbuffer", "texture"] as const).map((output) => ({
      backend,
      output,
      clustered: false,
    })),
  ),
  {
    backend: "webgl2" as const,
    output: "backbuffer" as const,
    clustered: true,
  },
];
for (const { backend, output, clustered } of configurations) {
  test(
    clustered
      ? "Clustered FrameGraph keeps one contribution through managed shadow promotion and demotion"
      : `Forward FrameGraph borrows admitted shadows with pixel, refresh and scene ownership parity on ${backend} ${output}`,
    async ({ page }, testInfo) => {
      test.setTimeout(150_000);
      const errors: string[] = [];
      const externalRequests: string[] = [];
      await page.route(
        /https:\/\/cdn\.babylonjs\.com\/.*(?:glslang|twgsl)/,
        async (route) => {
          externalRequests.push(route.request().url());
          await route.abort();
        },
      );
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          ["warning", "error"].includes(message.type()) &&
          /shader|ERROR: 0:|VALIDATE_STATUS|GL_INVALID|GL_OUT_OF_MEMORY|context lost|WebGPU uncaptured/i.test(
            message.text(),
          )
        )
          errors.push(message.text());
      });
      await page.goto("/?test=1&framegraphShadowProof=1");
      await page.waitForFunction(
        () =>
          typeof (
            window as unknown as {
              __babylonslateFrameGraphShadowProof?: unknown;
            }
          ).__babylonslateFrameGraphShadowProof === "function",
      );
      const result = await page.evaluate(
        ({ backend, output, clustered }) =>
          (
            window as unknown as {
              __babylonslateFrameGraphShadowProof: typeof runFrameGraphShadowProof;
            }
          ).__babylonslateFrameGraphShadowProof(backend, output, { clustered }),
        { backend, output, clustered },
      );
      await testInfo.attach("framegraph-managed-shadow-proof", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      expect(errors).toEqual([]);
      expect(externalRequests).toEqual([]);
      expect(result.backend).toBe(backend);
      expect(result.output).toBe(output);
      expect(result.webGLVersion).toBe(backend === "webgl2" ? 2 : null);
      expect(result.captures).toHaveLength(54);
      const difference = (a: number[], b: number[]) => {
        expect(a.length).toBe(b.length);
        let maximum = 0;
        for (let i = 0; i < a.length; i++)
          maximum = Math.max(maximum, Math.abs(a[i]! - b[i]!));
        return maximum;
      };
      for (const capture of result.captures) {
        expect(capture.prepared, capture.name).toEqual({ path: "frameGraph" });
        expect(capture.graph.result, capture.name).toEqual({
          path: "frameGraph",
        });
        expect(capture.forceGraph.result, capture.name).toEqual({
          path: "frameGraph",
        });
        expect(capture.readinessDraws, capture.name).toBe(0);
        expect(capture.readinessFaces, capture.name).toBe(0);
        expect(capture.classic.classicReadyBefore, capture.name).toBe(true);
        expect(capture.sameMap, capture.name).toBe(true);
        expect(capture.graph.pixels.length, capture.name).toBe(
          capture.width * capture.height * 4,
        );
        expect(capture.classic.draws, capture.name).toBeGreaterThanOrEqual(4);
        expect(capture.forceGraph.draws, capture.name).toBe(
          capture.classic.draws,
        );
        const disabled = capture.name.endsWith("-disabled");
        const sun = capture.name.includes("-sun-");
        const faces = disabled
          ? 0
          : capture.name.includes("-point-")
            ? 6
            : sun
              ? 2
              : 1;
        expect(capture.allocations, capture.name).toBe(
          (disabled ? 0 : 1) + Number(clustered),
        );
        expect(capture.sameMask, capture.name).toBe(true);
        expect(capture.clusterCount, capture.name).toBe(
          clustered ? 48 + Number(disabled && !sun) : 0,
        );
        expect(capture.keyContributions, capture.name).toBe(1);
        for (const frame of [
          capture.graph,
          capture.classic,
          capture.settled,
          capture.forceGraph,
        ])
          expect(frame.maskPasses, capture.name).toBe(Number(clustered));
        expect(capture.generatorEntries, capture.name).toBe(disabled ? 0 : 1);
        expect(capture.classic.faces, capture.name).toBe(faces);
        expect(capture.forceGraph.faces, capture.name).toBe(faces);
        expect(capture.settled.faces, capture.name).toBe(
          sun && !disabled ? 2 : 0,
        );
        if (sun && !disabled) expect(capture.cascades, capture.name).toBe(2);
        for (const frame of [
          capture.graph,
          capture.settled,
          capture.forceGraph,
        ]) {
          expect(
            difference(frame.pixels, capture.classic.pixels),
            capture.name,
          ).toBeLessThanOrEqual(1);
        }
        if (
          /-initial$|-caster-moved$|-light-moved$|-reloaded$/.test(capture.name)
        )
          expect(capture.graph.faces, capture.name).toBe(faces);
      }
      for (const entry of result.lifecycle) {
        expect(entry.stableAllocation, entry.name).toBe(true);
        expect(entry.stableMask, entry.name).toBe(true);
        expect(entry.maskOwnedAfterGraphDispose, entry.name).toBe(true);
        expect(entry.liveChildrenAfterOwnerDispose, entry.name).toBe(
          clustered ? 48 : 0,
        );
        expect(entry.remainingClusterMaps, entry.name).toBe(0);
        expect(entry.ownedAfterGraphDispose, entry.name).toBe(true);
        expect(entry.outputReferences, entry.name).toEqual(
          output === "texture" ? [1, 1] : null,
        );
        expect(entry.outputUsable, entry.name).toBe(true);
        expect(entry.retainedGraphObjects, entry.name).toBe(0);
        expect(entry.siblingPreserved, entry.name).toBe(true);
        expect(entry.remainingScenes, entry.name).toBe(0);
        expect(
          difference(entry.siblingBefore.pixels, entry.siblingAfter.pixels),
          entry.name,
        ).toBeLessThanOrEqual(1);
        expect(
          difference(entry.initial, entry.reload),
          entry.name,
        ).toBeLessThanOrEqual(1);
        let shadowPixels = 0;
        for (let i = 0; i < entry.unshadowed.length; i += 4) {
          const green = entry.unshadowed[i + 1]!;
          if (
            green > 30 &&
            green > entry.unshadowed[i]! * 1.4 &&
            green > entry.unshadowed[i + 2]! * 1.2 &&
            green - entry.shadowed[i + 1]! > 8
          )
            shadowPixels++;
        }
        expect(
          shadowPixels,
          `${entry.name} must show real receiver shadows`,
        ).toBeGreaterThan(10);
        const pose = (name: string) =>
          result.captures.find(
            (capture) => capture.name === `${entry.name}-${name}`,
          )!.graph.pixels;
        expect(pose("caster-moved"), entry.name).not.toEqual(pose("initial"));
        expect(pose("light-moved"), entry.name).not.toEqual(
          pose("caster-moved"),
        );
      }
    },
  );
}

test("Shared managed lighting reservations constrain real clustered and shadow allocations across scenes", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      (message.type() === "error" || message.type() === "warning") &&
      /shader|ERROR: 0:|VALIDATE_STATUS|GL_INVALID|GL_OUT_OF_MEMORY|context lost/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  await page.goto("/?test=1&framegraphShadowProof=1");
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as {
          __babylonslateFrameGraphShadowProof?: unknown;
        }
      ).__babylonslateFrameGraphShadowProof === "function",
  );
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateFrameGraphShadowProof: typeof runFrameGraphShadowProof;
      }
    ).__babylonslateFrameGraphShadowProof("webgl2", "backbuffer", {
      clustered: true,
      constrainedResources: true,
    }),
  );
  await testInfo.attach("managed-lighting-reservations", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(result.webGLVersion).toBe(2);
  const proof = result.resourceProof!;
  expect(proof.before.shadowBytes).toBeGreaterThan(0);
  expect(proof.before.clusterBytes).toBeGreaterThan(0);
  expect(proof.starved.resources.reservedBytes).toBe(
    proof.before.reservedBytes,
  );
  expect(proof.starved.clusterCount).toBe(0);
  expect(proof.starved.shadowMaps).toBe(0);
  expect(proof.starved.ownedMaps).toBe(0);
  expect(proof.starved.reason).toContain("Shared managed lighting memory");
  expect(proof.starved.firstMapRetained).toBe(true);
  expect(proof.recovered.clusterCount).toBeGreaterThan(0);
  expect(proof.recovered.shadowMaps).toBe(1);
  expect(proof.recovered.ownedMaps).toBe(2);
  expect(proof.recovered.resources.reservedBytes).toBeLessThanOrEqual(
    proof.recovered.resources.limit,
  );
  expect(proof.recovered.resources.pendingBytes).toBe(0);
  expect(proof.disposed.reservedBytes).toBe(0);
  expect(result.captures).toHaveLength(3);
  for (const capture of result.captures) {
    expect(capture.prepared, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.readinessDraws, capture.name).toBe(0);
    expect(capture.sameMap && capture.sameMask, capture.name).toBe(true);
    expect(capture.graph.draws, capture.name).toBeGreaterThanOrEqual(4);
    for (const frame of [capture.graph, capture.settled, capture.forceGraph]) {
      const difference = Math.max(
        ...frame.pixels.map((value, index) =>
          Math.abs(value - capture.classic.pixels[index]!),
        ),
      );
      expect(difference, capture.name).toBeLessThanOrEqual(1);
      expect(
        frame.pixels.some((value, index) => index % 4 === 1 && value > 60),
        capture.name,
      ).toBe(true);
    }
  }
});
