import {
  MaterialPluginBase,
  ShaderLanguage,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from "@babylonjs/core";
import {
  bakedIrradianceFragmentDeclarations,
  bakedIrradianceVertexDeclarations,
  bakedIrradianceVertexMain,
  type BakedIrradianceSampling,
} from "./baked-irradiance";
import { CelMaterial } from "./cel-material";

/**
 * Adds the receiver's baked diffuse irradiance to one material clone's
 * diffuse accumulation. PBR and Standard surfaces pick the term up through
 * the material's own `diffuseBase`, so the authored albedo still composes the
 * outgoing color exactly as realtime diffuse does (`albedo * E * coverage /
 * PI`). CEL adapters receive only declarations; their `SLATE_BAKED` sample
 * lives inside the shared environment accumulation and enters the same ramp.
 */
export class BakedIrradiancePlugin extends MaterialPluginBase {
  readonly sampling: BakedIrradianceSampling;

  constructor(material: Material, sampling: BakedIrradianceSampling) {
    super(
      material,
      "SlateBakedIrradiance",
      220,
      { SLATE_BAKED: true, SLATE_BAKED_ENV: false },
      true,
      true,
    );
    this.sampling = sampling;
    this.doNotSerialize = true;
  }

  override getClassName(): string {
    return "BakedIrradiancePlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines.SLATE_BAKED = true;
    defines.SLATE_BAKED_ENV = this.sampling.includesEnvironment;
  }

  override isReadyForSubMesh(
    _defines: MaterialDefines,
    _scene: Scene,
    _engine: AbstractEngine,
    _subMesh: SubMesh,
  ): boolean {
    return this.sampling.texture.isReady();
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("slateBakedIrradiance");
  }

  override getAttributes(attributes: string[]): void {
    attributes.push("uv2");
  }

  override getUniforms() {
    // `slateBakedRect` lands in the material UBO (`ADDITIONAL_UBO_DECLARATION`
    // exists in the GLSL and WGSL declarations). Vertex/fragment declarations
    // go through `CUSTOM_*_DEFINITIONS` instead: WGSL shaders have no
    // `ADDITIONAL_VERTEX/FRAGMENT_DECLARATION` marker.
    return {
      ubo: [{ name: "slateBakedRect", size: 4, type: "vec4" }],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene): void {
    if (!uniformBuffer.useUbo || !this._material.isFrozen || !uniformBuffer.isSync) {
      uniformBuffer.updateFloat4(
        "slateBakedRect",
        this.sampling.scale[0],
        this.sampling.scale[1],
        this.sampling.offset[0],
        this.sampling.offset[1],
      );
    }
    if (scene.texturesEnabled) {
      uniformBuffer.setTexture("slateBakedIrradiance", this.sampling.texture);
    }
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.sampling.texture;
  }

  override getActiveTextures(activeTextures: BaseTexture[]): void {
    activeTextures.push(this.sampling.texture);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ) {
    const wgsl = shaderLanguage === ShaderLanguage.WGSL;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef SLATE_BAKED\n${bakedIrradianceVertexDeclarations(wgsl)}\n#endif`,
        CUSTOM_VERTEX_MAIN_END: `#ifdef SLATE_BAKED\n${bakedIrradianceVertexMain(wgsl)}\n#endif`,
      };
    }
    if (shaderType !== "fragment") return null;
    const code: Record<string, string> = {
      // The CEL adapter samples inside its environment accumulation, so the
      // declarations apply to it too; only the diffuse injection is skipped.
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef SLATE_BAKED\n${bakedIrradianceFragmentDeclarations(wgsl)}\n#endif`,
    };
    if (!(this._material instanceof CelMaterial)) {
      // Join `diffuseBase` just before each `finalDiffuse` declaration so the
      // baked term flows through the material's own diffuse/albedo multiply:
      // `vec3 finalDiffuse=diffuseBase` covers PBR and the three clamped
      // `vec3 finalDiffuse=clamp(diffuseBase*...)` variants cover Standard.
      // `UNLIT` materials keep their authored flat color.
      const add = `#if defined(SLATE_BAKED) && !defined(UNLIT)\ndiffuseBase+=slateBakedIrradianceSample();\n#endif\n`;
      code[wgsl ? "!(var finalDiffuse: vec3f=)" : "!(vec3 finalDiffuse=)"] =
        `${add}$1`;
    }
    return code;
  }
}
