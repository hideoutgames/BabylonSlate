import { DisplayColorBlock } from "./display-color-block";
import {
  AddBlock,
  FogBlock,
  FragmentOutputBlock,
  InputBlock,
  NodeMaterialSystemValues,
  VectorMergerBlock,
  type NodeMaterial,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
} from "@babylonjs/core";
import type { MaterialBuildPlan } from "@babylonslate/shader-graph";
import { CelLightBlock } from "./cel-light-block";
import {
  createConstantBlock,
  type MaterialPlumbing,
} from "./material-block-registry";
import { sceneRenderingSettings } from "./render-settings";
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
  let cel: NodeMaterialBlock | undefined;
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
    const next = useCel ? cel! : pbr;
    if (active === next) return;
    material.removeOutputNode(active);
    material.addOutputNode(next);
    active = next;
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

function createCelSurface(
  name: string,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
  outputPoint: OutputPoint,
): NodeMaterialBlock {
  const lighting = new CelLightBlock(`${name}_cel`);
  const fragment = new FragmentOutputBlock(`${name}_celFragment`);
  created.push(lighting, fragment);
  plumbing.worldPosition?.connectTo(lighting.worldPosition);
  plumbing.worldNormal4?.connectTo(lighting.worldNormal);
  plumbing.cameraPosition?.connectTo(lighting.cameraPosition);
  plumbing.view?.connectTo(lighting.view);
  const toDisplay = (point: NodeMaterialConnectionPoint, suffix: string) => {
    const conversion = new DisplayColorBlock(`${name}_${suffix}`);
    created.push(conversion);
    point.connectTo(conversion.color);
    return conversion.output;
  };
  const base = outputPoint("baseColor", `${name}_celBase`, true);
  if (base) toDisplay(base, "baseDisplay").connectTo(lighting.diffuseColor);
  else {
    const fallback = createConstantBlock(
      `${name}_celFallback`,
      "vec3",
      [0.8, 0.8, 0.8],
      true,
    );
    created.push(fallback);
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
  return fragment;
}
