import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { runShadowSelfShadowingProof } from "../apps/editor/src/testing/shadow-self-shadowing-proof";
import type { runNativeShadowProof } from "../apps/editor/src/testing/shadow-native-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const cases = [
  { backend: "webgl2", configuration: "live-transform", mode: "pbr" } as const,
  { backend: "webgl2", configuration: "live-transform", mode: "cel" } as const,
  ...(["webgl2", "webgpu"] as const).flatMap((backend) =>
    (["low", "cascade-fallback", "cascades", "transformed"] as const).flatMap((configuration) =>
      (["pbr", "cel"] as const).map((mode) => ({ backend, configuration, mode })))),
  { backend: "webgl2", configuration: "pcf-medium", mode: "pbr" } as const,
  { backend: "webgpu", configuration: "pcf-high", mode: "pbr" } as const,
];
for (const { backend, configuration, mode } of cases)
  test(`synthetic hard-face contacts remain shadowed without acne: ${backend} ${configuration} ${mode}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    let phase = "managed";
    page.on("pageerror", (error) => errors.push(`${phase}: ${error.message}`));
    page.on("console", (message) => {
      if (
        ["warning", "error"].includes(message.type()) &&
        /shader|ERROR: 0:|VALIDATE_STATUS|GL_INVALID|GL_OUT_OF_MEMORY|context lost|WebGPU uncaptured/i.test(
          message.text(),
        )
      )
        errors.push(`${phase}: ${message.text()}`);
    });
    await page.goto("/?test=1&shadowSelfShadowingProof=1");
    await page.waitForFunction(
      () =>
        typeof (
          window as unknown as {
            __babylonslateShadowSelfShadowingProof?: unknown;
          }
        ).__babylonslateShadowSelfShadowingProof === "function",
    );
    const result = await page.evaluate(
      ({ backend, mode, configuration }) =>
        (
          window as unknown as {
            __babylonslateShadowSelfShadowingProof: typeof runShadowSelfShadowingProof;
          }
        ).__babylonslateShadowSelfShadowingProof(
          backend,
          mode,
          configuration === "cascades" || configuration === "cascade-fallback" ? configuration : "low",
          {
            transformed: configuration === "transformed",
            liveTransform: configuration === "live-transform",
            filterQuality: configuration === "pcf-medium" ? "medium" : configuration === "pcf-high" ? "high" : "low",
          },
        ),
      { backend, mode, configuration },
    );
    for (const capture of result.captures)
      await testInfo.attach(capture.name, {
        body: Buffer.from(capture.png, "base64"),
        contentType: "image/png",
      });
    await testInfo.attach("synthetic-effective-settings", {
      body: JSON.stringify(
        {
          buildSha: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          host: "Playwright synthetic FrameGraph proof",
          os: process.platform,
          qualification:
            "software backend functional pixels; not A16 performance or original asset proof",
          ...result,
          captures: result.captures.map((capture) => ({
            name: capture.name,
            effective: capture.effective,
            assertions: capture.assertions,
            regions: capture.regions,
          })),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    if (backend === "webgl2" && configuration === "low" && mode === "pbr") {
      for (const receiverPlane of [false, true]) {
      phase = receiverPlane ? "native receiver plane" : "native baseline";
      const native = await page.evaluate(
        (input) => (window as unknown as {
          __babylonslateShadowNativeProof: typeof runNativeShadowProof;
        }).__babylonslateShadowNativeProof(input!),
        {
          ...result.nativeInput!, receiverPlane,
          depthBias: receiverPlane
            ? result.captures.find((capture) => capture.name === "automatic")!.effective.lights.find((light) => light.name === "oblique key")!.generator!.lastDrawBias[0]!.depthBias
            : result.nativeInput!.depthBias,
        },
      );
      for (const capture of native.captures)
        await testInfo.attach(`${receiverPlane ? "native-plane" : "native"}-${capture.name}`, {
          body: Buffer.from(capture.png, "base64"),
          contentType: "image/png",
        });
      await testInfo.attach(`${receiverPlane ? "native-plane" : "native"}-effective-settings`, {
        body: JSON.stringify({ ...native, captures: native.captures.map(({ name, regions }) => ({ name, regions })) }),
        contentType: "application/json",
      });
      for (const error of Object.values(native.effective.comparisonError)) {
        expect(error, "matched native projection and camera").not.toBeNull();
        expect(error!).toBeLessThan(0.00001);
      }
      }
    }
    expect(errors).toEqual([]);
    expect(result.backend).toBe(backend);
    expect(result.webGLVersion).toBe(backend === "webgl2" ? 2 : null);
    const mapIds = result.captures.map(
      (capture) =>
        capture.effective.lights.find(
          (light) => light.name === "oblique key",
        )?.generator?.map?.id,
    );
    expect(mapIds[0]).toBeDefined();
    expect(
      new Set(mapIds).size,
      "bias and pose edits reuse the admitted map",
    ).toBe(1);
    for (const capture of result.captures) {
      expect(
        capture.effective.backend.actual,
        `${capture.name} executed backend`,
      ).toBe(backend);
      if (!capture.assertions) continue;
      expect(
        capture.effective.requestedShadows.distance,
        capture.name,
      ).toBe(80);
      const generator = capture.effective.lights.find(
        (light) => light.name === "oblique key",
      )!.generator!;
      expect(generator.cascades).toBe(configuration === "cascades" ? 2 : 1);
      expect(generator.map?.width).toBe(1024);
      expect(generator.map?.height).toBe(1024);
      expect(generator.map?.anisotropy, `${capture.name} native shadow sampling`).toBe(1);
      const thin = capture.effective.models.find(
        (model) => model.name === "thin-slab",
      );
      if (thin)
        expect(
          thin.receiveShadows,
          `${capture.name} thin participation`,
        ).toBe(true);
      // The oracle classifies world-space points by independent ray/AABB
      // occlusion. Each pose compares frozen direct lighting in known lit
      // interiors and nearby contacts, never whole-image difference alone.
      for (const name of ["head", "torso", "left-arm", "right-arm", "left-leg", "right-leg", "ground"]) {
        const region = capture.regions[name]!;
        // On this small character the widest filters cover some entire faces
        // with legitimate penumbra. Require large known-lit regions elsewhere,
        // and check every remaining known-lit sample without reclassifying it.
        if (!configuration.startsWith("pcf-") || ["head", "left-arm", "ground"].includes(name))
          expect(region.lit, `${capture.name} ${name} lit population`).toBeGreaterThan(20);
        if (region.lit) expect(
          region.falseDark / region.lit,
          `${capture.name} ${name} spurious dark surface samples`,
        ).toBeLessThan(0.05);
      }
      const contacts =
        capture.name.includes("thin-contact") ||
        capture.name.includes("second-light-angle")
          ? ["torso", "ground", "thin-contact-ground", "thin-contact-edge"]
          : ["torso", "ground"];
      for (const name of contacts) {
        const region = capture.regions[name]!;
        expect(
          region.contact,
          `${capture.name} ${name} known occlusion population`,
        ).toBeGreaterThan(5);
        if (name === "thin-contact-edge")
          expect(
            region.contact,
            `${capture.name} distinct visible contact-edge pixels`,
          ).toBeGreaterThanOrEqual(10);
        expect(
          region.retainedContact / region.contact,
          `${capture.name} ${name} preserved contact coverage`,
        ).toBeGreaterThan(0.8);
      }
    }
  });
