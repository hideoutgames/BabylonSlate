import { afterEach, expect, it, vi } from "vitest";
import { AnimatedInputBlockTypes, ArcRotateCamera, MeshBuilder, NullEngine, PrecisionDate, Scene, Vector3 } from "@babylonjs/core";
import { convertGlslToMaterial, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

it("builds converted fragment math as native Babylon blocks with live numeric uniforms and seconds-based Time", async () => {
  const converted = convertGlslToMaterial(`
    precision highp float;
    varying vec2 vUV;
    uniform float uTime;
    uniform float gain;
    uniform vec3 tint;
    void main() {
      vec2 uv = vUV.yx;
      vec3 bands = vec3(sin(uv.x + uTime), cos(uv.y), 0.5);
      bands = clamp(bands * gain + tint, 0.0, 1.0);
      float alpha = smoothstep(0.0, 1.0, dot(uv, uv));
      gl_FragColor = vec4(mix(bands.zyx, bands.xxx, 0.25), alpha);
    }
  `, { bindings: { vUV: "uv", uTime: "time" } });
  if (!converted.ok) throw new Error(JSON.stringify(converted.diagnostics));
  const lowered = lowerMaterialDocument(converted.document);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));

  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "converted-fragment" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  disposers.push(compiled.dispose);
  expect(await compiled.ready).toEqual([]);
  expect(compiled.buildState).toBe("ready");
  expect(compiled.material.attachedBlocks.some((block) => block.getClassName() === "CustomBlock")).toBe(false);
  expect(compiled.material.compiledShaders).toContain("sin(");
  expect(compiled.material.compiledShaders).toContain("smoothstep(");

  for (const [name, value] of Object.entries({ gain: 0.17, "tint.x": 0.29, "tint.y": 0.43, "tint.z": 0.67 })) {
    expect(compiled.setParameter(name, { kind: "float", value })).toBe(true);
    const input = compiled.material.getInputBlocks().find((block) => block.value === value);
    expect(input?.output.endpoints.length).toBeGreaterThan(0);
    expect(input?.convertToLinearSpace).toBe(false);
  }

  new ArcRotateCamera("camera", 0, Math.PI / 4, 5, Vector3.Zero(), scene);
  const mesh = MeshBuilder.CreatePlane("material-probe", {}, scene);
  mesh.material = compiled.material;
  const time = compiled.material.getInputBlocks().find((block) => block.animationType !== AnimatedInputBlockTypes.None);
  expect(time).toBeDefined();
  vi.spyOn(engine, "getDeltaTime").mockReturnValue(0);
  const clock = vi.spyOn(PrecisionDate, "Now", "get");
  clock.mockReturnValue(engine.startTime + 250);
  scene.render();
  const before = time!.value as number;
  clock.mockReturnValue(engine.startTime + 1250);
  scene.render();
  expect((time!.value as number) - before).toBeCloseTo(1);
});
