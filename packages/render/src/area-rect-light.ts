import { Color3, Matrix, Quaternion, RectAreaLight, TransformNode, Vector3, type Scene } from "@babylonjs/core";
import { type AreaRectLightBinding } from "@babylonslate/core";
import { retainAreaLightLookup } from "./area-light-resources";
import { setAuthoredLightEnabled } from "./light-policy";

/** View-owned native adapter. Babylon emits -Z; authored components emit +Z. */
export class AreaRectLightOwner {
  readonly light: RectAreaLight;
  private readonly adapter: TransformNode;
  private readonly local = Matrix.Identity();
  private readonly actorWorld = Matrix.Identity();
  private readonly world = Matrix.Identity();
  private readonly native = Matrix.Identity();
  private readonly part = Matrix.Identity();
  private readonly x = Vector3.Zero();
  private readonly y = Vector3.Zero();
  private readonly z = Vector3.Zero();
  private readonly position = Vector3.Zero();
  private binding: AreaRectLightBinding;
  private diagnostic: string | undefined;
  private disposed = false;
  private dirty = true;
  private enabled: boolean | undefined;
  private readonly onDiagnostic?: (message: string) => void;

  constructor(scene: Scene, name: string, binding: AreaRectLightBinding, onDiagnostic?: (message: string) => void) {
    const releaseLookup = retainAreaLightLookup(scene);
    this.onDiagnostic = onDiagnostic;
    this.binding = binding;
    this.adapter = new TransformNode(`${name}:transform`, scene);
    try { this.light = new RectAreaLight(name, Vector3.Zero(), 1, 1, scene); }
    catch (error) { this.adapter.dispose(); releaseLookup(); throw error; }
    this.light.parent = this.adapter;
    this.light.onDisposeObservable.addOnce(() => {
      this.disposed = true;
      this.adapter.dispose();
      releaseLookup();
    });
    this.update(binding);
  }

  update(binding: AreaRectLightBinding): void {
    this.binding = binding;
    Matrix.IdentityToRef(this.local);
    for (const transform of binding.transforms) {
      Matrix.ComposeToRef(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation), Vector3.FromArray(transform.position), this.part);
      this.local.multiplyToRef(this.part, this.local);
    }
    const properties = binding.properties;
    this.light.width = properties.width;
    this.light.height = properties.height;
    this.light.diffuse = Color3.FromArray(properties.color);
    this.light.intensity = properties.intensity;
    this.dirty = true;
    this.enabled = undefined;
    // The owner is deliberately unshadowed. No shadow generator is registered.
    this.setWorld(this.actorWorld);
  }

  setWorld(actorWorld: Matrix): void {
    if (this.disposed) return;
    if (!this.dirty && this.actorWorld.equals(actorWorld)) return;
    this.dirty = false;
    this.actorWorld.copyFrom(actorWorld);
    this.local.multiplyToRef(actorWorld, this.world);
    Vector3.TransformNormalFromFloatsToRef(1, 0, 0, this.world, this.x);
    Vector3.TransformNormalFromFloatsToRef(0, 1, 0, this.world, this.y);
    Vector3.TransformNormalFromFloatsToRef(0, 0, 1, this.world, this.z);
    const lx = this.x.length(), ly = this.y.length(), lz = this.z.length();
    let error = this.binding.error ?? (this.binding.properties.textureGuid && !this.light.emissionTexture ? `Processed area-light emission texture is unavailable: ${this.binding.properties.textureGuid}` : undefined);
    if (!error && (!this.world.m.every(Number.isFinite) || Math.min(lx, ly, lz) < 0.000001)) error = "Rectangular Area Light requires a finite, non-degenerate transform.";
    if (!error && (Math.abs(Vector3.Dot(this.x, this.y)) > lx * ly * 0.00001 || Math.abs(Vector3.Dot(this.x, this.z)) > lx * lz * 0.00001 || Math.abs(Vector3.Dot(this.y, this.z)) > ly * lz * 0.00001)) error = "Rectangular Area Light does not support sheared transforms. Remove non-uniform scaling above a rotated child.";
    const changedDiagnostic = error !== this.diagnostic;
    if (changedDiagnostic) {
      this.diagnostic = error;
      if (error) this.onDiagnostic?.(error);
    }
    const enabled = this.binding.properties.enabled && !error;
    if (changedDiagnostic || !this.light.metadata) this.light.metadata = { areaLight: { componentId: this.binding.id, error: error ?? null, shadowed: false } };
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      setAuthoredLightEnabled(this.light, enabled);
    }
    if (error) return;
    // Reflect dimensions without reversing the authored emission side. Width
    // and height remain local units; parent scale is applied exactly once.
    this.x.scaleInPlace(this.world.determinant() < 0 ? 1 : -1);
    this.z.scaleInPlace(-1);
    Matrix.FromXYZAxesToRef(this.x, this.y, this.z, this.native);
    this.world.getTranslationToRef(this.position);
    this.native.setTranslation(this.position);
    this.adapter.freezeWorldMatrix(this.native);
  }

  get error(): string | undefined { return this.diagnostic; }
  dispose(): void { if (!this.disposed) this.light.dispose(); }
}

/** One actor's emitters, independent of whether its render meshes have arrived. */
export class AreaRectLightGroup {
  readonly emitters = new Map<string, AreaRectLightOwner>();
  private readonly world = Matrix.Identity();
  private signature = "";
  private readonly scene: Scene;
  private readonly name: string;
  private readonly onDiagnostic?: (message: string) => void;

  constructor(scene: Scene, name: string, onDiagnostic?: (message: string) => void) {
    this.scene = scene; this.name = name; this.onDiagnostic = onDiagnostic;
  }
  update(bindings: readonly AreaRectLightBinding[]): boolean {
    const signature = JSON.stringify(bindings);
    if (signature === this.signature) return false;
    const live = new Set(bindings.map((binding) => binding.id));
    for (const [id, emitter] of this.emitters) if (!live.has(id)) { emitter.dispose(); this.emitters.delete(id); }
    for (const binding of bindings) {
      let emitter = this.emitters.get(binding.id);
      if (emitter) emitter.update(binding);
      else { emitter = new AreaRectLightOwner(this.scene, `${this.name}:${binding.id}`, binding, this.onDiagnostic); this.emitters.set(binding.id, emitter); }
      emitter.setWorld(this.world);
    }
    this.signature = signature;
    return true;
  }
  setWorld(world: Matrix): void {
    this.world.copyFrom(world);
    for (const emitter of this.emitters.values()) emitter.setWorld(world);
  }
  dispose(): void { for (const emitter of this.emitters.values()) emitter.dispose(); this.emitters.clear(); this.signature = ""; }
}
