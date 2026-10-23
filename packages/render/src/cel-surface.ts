import { DisplayColorBlock } from "./display-color-block";
import {
  AddBlock,
  FogBlock,
  InputBlock,
  NodeMaterialSystemValues,
  VectorMergerBlock,
  type NodeMaterial,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
} from "@babylonjs/core";
import type { MaterialBuildPlan } from "@haptic/shader-graph";
import { CelLightBlock } from "./cel-light-block";
import {
  createConstantBlock,
  type MaterialPlumbing,
} from "./material-block-registry";
import { sceneRenderingSettings } from "./render-settings";
import { GeometrySurfaceOutputBlock, connectGeometrySurfaceOutput } from "./geometry-surface-output-block";
import { syncSceneLighting } from "./scene-lighting";

type OutputPoint = (
  pin: string,
  name: string,
  color: boolean,
) => NodeMaterialConnectionPoint | null;

export function installCelSurface(
  material: NodeMaterial,
  plan: MaterialBuildPlan,
  pbr: NodeMaterialBlock,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
  outputPoint: OutputPoint,
): void {
  if (plan.shadingModel === "unlit") return;
  const state = sceneRenderingSettings(material.getScene());
  let cel: CelSurface | undefined;
  let active = pbr;
  let disposed = false;
  let queued = false;
  const select = (rebuild: boolean): void => {
    if (disposed) return;
    // A newly activated block can still be loading its shader includes.
    // Coalesce subsequent toggles without mutating a graph mid-build.
    if (rebuild && material.buildIsInProgress) {
      if (!queued) {
        queued = true;
        material.onBuildObservable.addOnce(() => {
          queueMicrotask(() => {
            queued = false;
            select(true);
          });
        });
      }
      return;
    }
    const useCel = state.mode === "cel";
    if (useCel && !cel)
      cel = createCelSurface(material.name, created, plumbing, outputPoint);
    const next = useCel ? cel!.output : pbr;
    // A NodeMaterial allows one CelLightBlock, so reflections change the one CEL surface's connections.
    const reflectivityChanged = useCel && cel!.setReflective(state.celReflections);
    if (active === next && !reflectivityChanged) return;
    if (active !== next) {
      material.removeOutputNode(active);
      material.addOutputNode(next);
      active = next;
    }
    if (!rebuild) return;
    const frozen = material.isFrozen;
    material.unfreeze();
    try {
      material.build();
      material.markDirty(true);
      material.resetDrawCache();
      syncSceneLighting(material.getScene());
    } finally {
      if (frozen) material.freeze();
    }
  };
  select(false);
  const listener = () => select(true);
  state.listeners.add(listener);
  material.onDisposeObservable.addOnce(() => {
    disposed = true;
    state.listeners.delete(listener);
  });
}

interface CelSurface {
  output: NodeMaterialBlock;
  /** Connects or disconnects the reflectivity inputs; true when that changed the graph. */
  setReflective(reflective: boolean): boolean;
}

function createCelSurface(
  name: string,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
  outputPoint: OutputPoint,
): CelSurface {
  const lighting = new CelLightBlock(`${name}_cel`);
  const fragment = new GeometrySurfaceOutputBlock(`${name}_celFragment`);
  connectGeometrySurfaceOutput(fragment, plumbing, outputPoint("normal", `${name}_geometryNormal`, false), created);
  created.push(lighting, fragment);
  plumbing.worldPosition?.connectTo(lighting.worldPosition);
  plumbing.worldNormal4?.connectTo(lighting.worldNormal);
  plumbing.cameraPosition?.connectTo(lighting.cameraPosition);
  plumbing.view?.connectTo(lighting.view);
  outputPoint("environmentInfluence", `${name}_celEnvironmentInfluence`, false)?.connectTo(lighting.environmentInfluence);
  const toDisplay = (point: NodeMaterialConnectionPoint, suffix: string) => {
    const conversion = new DisplayColorBlock(`${name}_${suffix}`);
    created.push(conversion);
    point.connectTo(conversion.color);
    return conversion.output;
  };
  let base = outputPoint("baseColor", `${name}_celBase`, true);
  if (base) toDisplay(base, "baseDisplay").connectTo(lighting.diffuseColor);
  else {
    const fallback = createConstantBlock(
      `${name}_celFallback`,
      "vec3",
      [0.8, 0.8, 0.8],
      true,
    );
    created.push(fallback);
    base = fallback.output;
    toDisplay(fallback.output, "fallbackDisplay").connectTo(lighting.diffuseColor);
  }
  const normal = outputPoint("normal", `${name}_celNormal`, false);
  if (normal) {
    const widen = new VectorMergerBlock(`${name}_celNormalWiden`);
    created.push(widen);
    normal.connectTo(widen.xyzIn);
    lighting.worldNormal.connectedPoint?.disconnectFrom(lighting.worldNormal);
    widen.xyzw.connectTo(lighting.worldNormal);
  }
  const specular = new AddBlock(`${name}_celHighlights`);
  lighting.diffuseOutput.connectTo(specular.left);
  lighting.specularOutput.connectTo(specular.right);
  created.push(specular);
  let color = specular.output;
  const emissive = outputPoint("emissive", `${name}_celEmission`, true);
  if (emissive) {
    const emission = new AddBlock(`${name}_celEmissive`);
    created.push(emission);
    color.connectTo(emission.left);
    toDisplay(emissive, "emissionDisplay").connectTo(emission.right);
    color = emission.output;
  }
  const fog = new FogBlock(`${name}_celFog`);
  created.push(fog);
  color.connectTo(fog.input);
  plumbing.worldPosition?.connectTo(fog.worldPosition);
  plumbing.view?.connectTo(fog.view);
  const fogColor = new InputBlock(`${name}_celFogColor`);
  fogColor.setAsSystemValue(NodeMaterialSystemValues.FogColor);
  created.push(fogColor);
  fogColor.output.connectTo(fog.fogColor);
  fog.output.connectTo(fragment.rgb);
  const opacity = outputPoint("opacity", `${name}_celOpacity`, false);
  if (opacity) opacity.connectTo(fragment.a);
  // LightBlock's output is display-space, with no PBR or image-processing block.
  fragment.convertToGammaSpace = false;
  fragment.convertToLinearSpace = false;
  // Reflectivity uses the PBR surface's encoding (geometry-surface-output-block.ts), so a CEL surface reflects as its
  // Material does in PBR, from the linear base color rather than the display one CEL lights with. Connected only
  // while reflections run: metallic and roughness textures would otherwise bind on every flat CEL draw.
  const baseColor = base;
  let channels: [NodeMaterialConnectionPoint | null, NodeMaterialConnectionPoint][] | undefined;
  let reflective = false;
  const setReflective = (next: boolean): boolean => {
    if (next === reflective) return false;
    reflective = next;
    channels ??= [
      [baseColor, fragment.geometryBaseColor],
      [outputPoint("metallic", `${name}_celMetallic`, false), fragment.geometryMetallic],
      [outputPoint("roughness", `${name}_celRoughness`, false), fragment.geometryRoughness],
    ];
    for (const [source, input] of channels) {
      if (!source) continue;
      if (next) source.connectTo(input);
      else source.disconnectFrom(input);
    }
    return true;
  };
  return { output: fragment, setReflective };
}
