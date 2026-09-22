import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { runShadowSelfShadowingProof } from "../apps/editor/src/testing/shadow-self-shadowing-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const)
  for (const configuration of ["low", "cascade-fallback", "cascades"] as const)
    for (const mode of ["pbr", "cel"] as const)
      test(`synthetic hard-face contacts remain shadowed without acne: ${backend} ${configuration} ${mode}`, async ({
        page,
      }, testInfo) => {
        test.setTimeout(120_000);
        const errors: string[] = [];
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
              configuration,
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
              captures: result.captures.map(
                ({ png: _png, ...capture }) => capture,
              ),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
        expect(errors).toEqual([]);
        expect(result.backend).toBe(backend);
        expect(result.webGLVersion).toBe(backend === "webgl2" ? 2 : null);
        const automatic = result.captures.find(
          (capture) => capture.name === "automatic",
        )!;
        // The oracle classifies world-space surface points by ray/AABB occlusion,
        // independently of the shadow map. Compare only known lit interiors and
        // known nearby contacts against the same frozen direct-light image.
        for (const name of ["head", "torso", "ground"]) {
          const region = automatic.regions[name]!;
          expect(region.lit, `${name} lit sample population`).toBeGreaterThan(
            20,
          );
          expect(
            region.falseDark / region.lit,
            `${name} spurious dark surface samples`,
          ).toBeLessThan(0.05);
        }
        for (const name of ["torso", "ground"]) {
          const region = automatic.regions[name]!;
          expect(
            region.contact,
            `${name} known occlusion population`,
          ).toBeGreaterThan(5);
          expect(
            region.retainedContact / region.contact,
            `${name} preserved self-shadow/contact coverage`,
          ).toBeGreaterThan(0.8);
        }
      });
