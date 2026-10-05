import { afterEach, expect, it } from "vitest";
import { NullEngine, PBRMaterial, Scene, ShadowDepthWrapper, StandardMaterial } from "@babylonjs/core";
import { ensureNativeLatticeShadowDepthWrapper, releaseNativeLatticeShadowDepthWrapper } from "./native-lattice-shadow";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

it.each([StandardMaterial, PBRMaterial])("shares native shadow support until the last cage detaches", async (MaterialType) => {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const source = new MaterialType("shared", scene);
  expect(ensureNativeLatticeShadowDepthWrapper(source)).toBe(true);
  const wrapper = source.shadowDepthWrapper;
  expect(ensureNativeLatticeShadowDepthWrapper(source)).toBe(true);
  expect(source.shadowDepthWrapper).toBe(wrapper);
  await releaseNativeLatticeShadowDepthWrapper(source);
  expect(source.shadowDepthWrapper).toBe(wrapper);
  await releaseNativeLatticeShadowDepthWrapper(source);
  expect(source.shadowDepthWrapper).toBeNull();
  expect(scene.materials).toContain(source);
  // A later cage can reacquire, and source disposal releases its active lease.
  ensureNativeLatticeShadowDepthWrapper(source);
  expect(source.shadowDepthWrapper).not.toBe(wrapper);
  source.dispose();
  expect(source.shadowDepthWrapper).toBeNull();
  await releaseNativeLatticeShadowDepthWrapper(source);
});

it("preserves caller-owned shadow wrappers when acquisition is unsupported", () => {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const source = new StandardMaterial("custom", scene);
  const wrapper = new ShadowDepthWrapper(source);
  source.shadowDepthWrapper = wrapper;
  expect(() => ensureNativeLatticeShadowDepthWrapper(source)).toThrow("custom shadow wrapper");
  expect(source.shadowDepthWrapper).toBe(wrapper);
  wrapper.dispose();
});
