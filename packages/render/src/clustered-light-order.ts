import {
  RawTexture,
  type Light,
  type Observer,
  type RenderTargetTexture,
} from "@babylonjs/core";
import { LightConstants } from "@babylonjs/core/Lights/lightConstants";
import type { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";

type PackedLights = {
  _sortedLights: Light[];
  _lightDataBuffer: Float32Array;
  _lightDataTexture: RawTexture;
  _sliceRanges: Float32Array;
  _lightDataRenderId: number;
};

/** Babylon 9.20 packs by camera depth; CEL ties require stable authored order. */
export class ClusteredLightOrder {
  private map: RenderTargetTexture | undefined;
  private observer: Observer<RenderTargetTexture> | undefined;
  private registry: readonly Light[] | undefined;
  private readonly authored = new Map<Light, number>();
  private readonly destination = new Map<Light, number>();
  private readonly ordered: Light[] = [];
  private scratch = new Float32Array(0);
  private indices = new Int32Array(0);
  private renderId = -1;
  private buffer: Float32Array | undefined;
  private readonly native: PackedLights;

  private readonly container: ClusteredLightContainer;

  constructor(container: ClusteredLightContainer) {
    this.container = container;
    const native = container as unknown as PackedLights;
    if (
      !Array.isArray(native._sortedLights) ||
      !(native._lightDataBuffer instanceof Float32Array) ||
      !(native._lightDataTexture instanceof RawTexture) ||
      !(native._sliceRanges instanceof Float32Array) ||
      typeof native._lightDataRenderId !== "number"
    )
      throw new Error("Unsupported Babylon clustered packing layout.");
    this.native = native;
  }

  sync(map: RenderTargetTexture, registry: readonly Light[]): void {
    if (this.registry !== registry) {
      this.registry = registry;
      this.authored.clear();
      registry.forEach((light, index) => this.authored.set(light, index));
    }
    if (this.map === map) return;
    if (this.map && this.observer)
      this.map.onBeforeBindObservable.remove(this.observer);
    this.map = map;
    this.renderId = -1;
    // Runs after the native packer and conservative camera-bounds adapter. The
    // texture is borrowed; this observer owns neither the rows nor the texture.
    this.observer = map.onBeforeBindObservable.add(() => this.reorder());
  }

  dispose(): void {
    if (this.map && this.observer)
      this.map.onBeforeBindObservable.remove(this.observer);
    this.map = undefined;
    this.observer = undefined;
  }

  private reorder(): void {
    const native = this.native;
    if (
      this.renderId === native._lightDataRenderId &&
      this.buffer === native._lightDataBuffer
    )
      return;
    this.renderId = native._lightDataRenderId;
    this.buffer = native._lightDataBuffer;
    const source = native._sortedLights;
    if (
      native._lightDataBuffer.length < source.length * 20 ||
      native._sliceRanges.length !== this.container.depthSlices * 2
    )
      throw new Error("Clustered light row or slice layout changed.");
    this.ordered.length = source.length;
    for (let i = 0; i < source.length; i++) this.ordered[i] = source[i]!;
    this.ordered.sort(
      (a, b) =>
        (this.container.getScene().requireLightSorting
          ? LightConstants.CompareLightsPriority(a, b)
          : 0) ||
        (this.authored.get(a) ?? a.uniqueId) -
          (this.authored.get(b) ?? b.uniqueId),
    );
    if (this.ordered.every((light, index) => light === source[index])) return;
    this.destination.clear();
    this.ordered.forEach((light, index) => this.destination.set(light, index));
    if (this.scratch.length !== native._lightDataBuffer.length)
      this.scratch = new Float32Array(native._lightDataBuffer.length);
    if (this.indices.length < source.length)
      this.indices = new Int32Array(source.length);
    this.scratch.set(native._lightDataBuffer);
    for (let index = 0; index < source.length; index++) {
      const destination = this.destination.get(source[index]!)!;
      this.indices[index] = destination;
      for (let scalar = 0; scalar < 20; scalar++)
        this.scratch[destination * 20 + scalar] =
          native._lightDataBuffer[index * 20 + scalar]!;
    }
    // Native slices describe contiguous depth-sorted indices. Their enclosing
    // interval in authored order can include extra rows, but cannot omit one.
    for (let slice = 0; slice < native._sliceRanges.length; slice += 2) {
      const first = native._sliceRanges[slice]!;
      const last = native._sliceRanges[slice + 1]!;
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < 0 ||
        last >= source.length ||
        last < first
      )
        throw new Error("Clustered light slice indices changed.");
      let low = source.length;
      let high = 0;
      for (let index = first; index <= last; index++) {
        low = Math.min(low, this.indices[index]!);
        high = Math.max(high, this.indices[index]!);
      }
      native._sliceRanges[slice] = low;
      native._sliceRanges[slice + 1] = high;
    }
    // Mirror Babylon's WebGPU _updateLightData contract: flush pending
    // framebuffer work before overwriting texture data earlier passes read.
    const engine = this.container.getScene().getEngine();
    if (engine.isWebGPU) engine.flushFramebuffer();
    native._lightDataBuffer.set(this.scratch);
    native._lightDataTexture.update(native._lightDataBuffer);
  }
}
