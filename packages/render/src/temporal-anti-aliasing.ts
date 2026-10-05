import { Camera, Matrix, type Observer, type Scene } from "@babylonjs/core";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { syntax } from "./ambient-occlusion-shader";

function halton(index: number, base: number): number {
  let fraction = 1, result = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    fraction /= base;
    result += fraction * (i % base);
  }
  return result;
}

/**
 * History resolve: the previous output is reprojected through the linear
 * velocity buffer (the longest vector in the 3x3 neighborhood, so edges carry
 * their motion), clamped to the current neighborhood's YCoCg bounds and
 * blended with luminance weights so HDR highlights cannot dominate.
 *
 * Uniforms: `taaSettings` (current-frame blend, reset flag, texel size) and
 * `taaJitter`, the jitter change in UV that velocity includes.
 */
export function temporalAntiAliasingShader(wgsl: boolean): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, sample, output, main } = syntax(wgsl);
  const ycocg = (c: string) => `${v3}(dot(${c}, ${v3}(0.25, 0.5, 0.25)), dot(${c}, ${v3}(0.5, 0.0, -0.5)), dot(${c}, ${v3}(-0.25, 0.5, -0.25)))`;
  const header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("textureSampler")}${texture("historySampler")}${texture("velocitySampler")}
${field(v4, "taaSettings")}${field(v2, "taaJitter")}
`;
  const taps = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([x, y]) => `{
  ${decl(v2, "tap", `${uv} + ${v2}(${x}.0, ${y}.0) * ${u("taaSettings")}.zw`)}
  ${decl(v3, "neighbor", ycocg(`${sample("textureSampler", "tap")}.rgb`))}
  low = min(low, neighbor);
  high = max(high, neighbor);
  ${decl(v2, "motion", `${sample("velocitySampler", "tap")}.xy`)}
  if (dot(motion, motion) > dot(velocity, velocity)) { velocity = motion; }
}`).join("\n");
  const body = `
${decl(v4, "current", sample("textureSampler", uv))}
${decl(v3, "low", ycocg("current.rgb"))}
${decl(v3, "high", "low")}
${decl(v2, "velocity", `${sample("velocitySampler", uv)}.xy`)}
${taps}
${decl(v2, "previous", `${uv} + velocity - ${u("taaJitter")}`)}
if (${u("taaSettings")}.y > 0.5 || previous.x < 0.0 || previous.y < 0.0 || previous.x > 1.0 || previous.y > 1.0) {
  ${output("current")}
}
${decl(v3, "history", ycocg(`${sample("historySampler", "previous")}.rgb`))}
history = clamp(history, low, high);
${decl(v3, "past", `${v3}(history.x + history.y - history.z, history.x + history.z, history.x - history.y - history.z)`)}
${decl(f, "currentWeight", `${u("taaSettings")}.x / (1.0 + max(dot(current.rgb, ${v3}(0.25, 0.5, 0.25)), 0.0))`)}
${decl(f, "pastWeight", `(1.0 - ${u("taaSettings")}.x) / (1.0 + max(history.x, 0.0))`)}
${output(`${v4}((current.rgb * currentWeight + past * pastWeight) / max(currentWeight + pastWeight, 0.000001), current.a)`)}
`;
  return header + main(body);
}

/**
 * Per-frame sub-pixel projection jitter for one camera. The camera's own
 * projection is never modified: jittered draws receive a jittered copy, and
 * the camera's matrix is restored once they finish, so picking, gizmo layers
 * and later passes see the unjittered view.
 */
export class TemporalJitter {
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly samples: number;
  private readonly width: number;
  private readonly height: number;
  private readonly matrix = new Matrix();
  private readonly values = new Float32Array(16);
  private readonly cleanup: (() => void)[] = [];
  private frame = -1;
  private index = 0;
  private x = 0;
  private y = 0;
  private previousX = 0;
  private previousY = 0;

  constructor(scene: Scene, camera: Camera, samples: number, width: number, height: number) {
    this.scene = scene;
    this.camera = camera;
    this.samples = samples;
    this.width = width;
    this.height = height;
  }

  /**
   * Velocity is measured between jittered frames, but history holds resolved
   * (unjittered) color: this UV offset removes the jitter change from it.
   */
  get velocityOffset(): [number, number] {
    return [(this.previousX - this.x) * 0.5, (this.previousY - this.y) * 0.5];
  }

  /** The camera's projection offset by this frame's sub-pixel jitter. */
  projection(): Matrix {
    const frame = this.scene.getFrameId();
    if (frame !== this.frame) {
      this.frame = frame;
      this.index = (this.index % this.samples) + 1;
      this.previousX = this.x;
      this.previousY = this.y;
      // NDC spans two units per axis; offsets stay within half a pixel.
      this.x = (halton(this.index, 2) - 0.5) * 2 / this.width;
      this.y = (halton(this.index, 3) - 0.5) * 2 / this.height;
    }
    this.values.set(this.camera.getProjectionMatrix(true).m);
    if (this.camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
      this.values[12]! += this.x;
      this.values[13]! += this.y;
    } else {
      // Perspective clip w is m[11] * view z; scaling keeps the NDC offset exact.
      this.values[8]! += this.x * this.values[11]!;
      this.values[9]! += this.y * this.values[11]!;
    }
    Matrix.FromArrayToRef(this.values, 0, this.matrix);
    return this.matrix;
  }

  private restore(): void {
    this.scene.setTransformMatrix(this.camera.getViewMatrix(), this.camera.getProjectionMatrix());
  }

  /** Jitter a FrameGraph object renderer's draws for this camera. Babylon's
   * graph tasks recompute the projection just before drawing; jitter after. */
  jitterRenderer(renderer: ObjectRenderer): void {
    const draw = renderer.onBeforeRenderingManagerRenderObservable.add(() => {
      if ((renderer.activeCamera ?? this.scene.activeCamera) === this.camera)
        this.scene.setTransformMatrix(this.camera.getViewMatrix(), this.projection());
    });
    const finish = renderer.onFinishRenderingObservable.add(() => {
      if ((renderer.activeCamera ?? this.scene.activeCamera) === this.camera) this.restore();
    });
    this.cleanup.push(() => {
      renderer.onBeforeRenderingManagerRenderObservable.remove(draw);
      renderer.onFinishRenderingObservable.remove(finish);
    });
  }

  /** Jitter the native draw phase (including the MRT prepass) of this camera. */
  jitterDrawPhase(): void {
    const observers: [Scene["onBeforeDrawPhaseObservable"], Observer<Scene>][] = [];
    const add = (observable: Scene["onBeforeDrawPhaseObservable"], apply: () => void) =>
      observers.push([observable, observable.add(() => {
        if (this.scene.activeCamera !== this.camera) return;
        apply();
        this.scene.finalizeSceneUbo();
      })]);
    add(this.scene.onBeforeDrawPhaseObservable, () =>
      this.scene.setTransformMatrix(this.camera.getViewMatrix(), this.projection()));
    add(this.scene.onAfterDrawPhaseObservable, () => this.restore());
    this.cleanup.push(() => {
      for (const [observable, observer] of observers) observable.remove(observer);
    });
  }

  dispose(): void {
    for (const action of this.cleanup.splice(0)) action();
  }
}
