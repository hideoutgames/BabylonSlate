import { createDefaultMaterialDocument, type MaterialDocument, type MaterialGraphEdge, type MaterialGraphNode } from "./document";
import { materialPinDefaultPropertyKey } from "./pin-defaults";

/**
 * A Surface Material for a Water asset's Custom Material that draws what built-in water draws, wired from the water
 * nodes so every part of the look can be edited. It moves with the asset's waves (Water Waves' Offset into World
 * Position Offset, its Normal into Normal), so a body drawn with it matches what floating objects ride, and takes the
 * asset's colours (Water Colors), so the Water asset's Inspector still applies.
 *
 * It is lit and translucent, after FFT-Ocean: the water's colour is emitted (Deep Color with the subsurface light through
 * the crests in Shallow Color, times the scene's light on it; in shallow water what lies below, by the Transmittance
 * built-in water sees through it), the reflection is mixed over it by its Fresnel, foam is Foam Color as rough lit albedo
 * with a faint glow, and the scene's lights add the sun's highlight on the waves.
 */
export function createWaterMaterialDocument(name: string): MaterialDocument {
  const doc = createDefaultMaterialDocument(name);
  doc.blendMode = "translucent";
  doc.shadingModel = "pbr";
  const nodes: MaterialGraphNode[] = [doc.nodes.find((node) => node.type === "output.surface")!];
  const edges: MaterialGraphEdge[] = [];
  const node = (id: string, type: string, x: number, y: number, defaults: Record<string, number | readonly number[]> = {}) => {
    const properties: Record<string, unknown> = {};
    for (const [pin, value] of Object.entries(defaults)) properties[materialPinDefaultPropertyKey(pin)] = typeof value === "number" ? [value] : [...value];
    nodes.push({ id, type, position: { x, y }, properties });
  };
  const constant = (id: string, x: number, y: number, value: number) => {
    node(id, "const.float", x, y);
    nodes[nodes.length - 1]!.properties.value = [value];
  };
  const wire = (source: string, pin: string, target: string, targetPin: string) =>
    edges.push({ id: `e-${source}-${pin}-${target}-${targetPin}`, sourceNodeId: source, sourcePinId: pin, targetNodeId: target, targetPinId: targetPin });
  const out = (source: string, pin: string, target: string) => wire(source, pin, "output", target);
  // A Float wired into a colour's pin widens to (t, 1, 1): a Combine node repeats it on every channel.
  const splat = (source: string, pin: string, target: string, targetPin: string) => {
    const id = `${target}${targetPin[0]!.toUpperCase()}${targetPin.slice(1)}`, at = nodes.find((entry) => entry.id === target)!.position;
    node(id, "vector.combine", at.x - 160, at.y + 120);
    for (const channel of ["x", "y", "z"]) wire(source, pin, id, channel);
    wire(id, "xyz", target, targetPin);
  };
  const output = nodes[0]!;
  output.position = { x: 1400, y: 0 };

  node("waves", "input.waterWaves", -1000, -400);
  node("colors", "input.waterColors", -1000, 0);
  node("depth", "input.waterDepthFade", -1000, 260);
  node("scene", "input.waterSceneColor", -1000, 460);
  node("reflection", "input.waterReflection", -1000, 700);
  node("foam", "input.waterFoam", -1000, 940);
  out("waves", "offset", "worldPositionOffset");
  out("waves", "normal", "normal");

  // Deep water: Deep Color, with the light scattered through the crests in Shallow Color.
  node("scatter", "math.multiply", -600, -120);
  wire("colors", "shallowColor", "scatter", "a"); splat("waves", "subsurface", "scatter", "b");
  node("deepGlow", "math.add", -450, -60);
  wire("colors", "deepColor", "deepGlow", "a"); wire("scatter", "out", "deepGlow", "b");
  // Lit by the scene as built-in water is: a dim scene keeps a dim sea.
  node("deep", "math.multiply", -300, -60);
  wire("deepGlow", "out", "deep", "a"); splat("colors", "sceneLight", "deep", "b");
  // Shallow water: what lies below shows through by the water's Transmittance, the deep water's colour where it does not.
  node("below", "math.mix", -300, 200);
  wire("deep", "out", "below", "a"); wire("scene", "color", "below", "b"); wire("depth", "transmittance", "below", "alpha");
  node("body", "math.mix", 0, 120);
  wire("deep", "out", "body", "a"); wire("below", "out", "body", "b"); splat("scene", "available", "body", "alpha");
  node("water", "math.mix", 300, 200);
  wire("body", "out", "water", "a"); wire("reflection", "color", "water", "b"); splat("reflection", "fresnel", "water", "alpha");
  // Foam hides the water: rough lit albedo with a faint glow, so it stays light in shade.
  node("foamGlow", "math.multiply", 300, 360, { b: [0.35, 0.35, 0.35] });
  wire("colors", "foamColor", "foamGlow", "a");
  node("clear", "math.mix", 600, 260);
  wire("water", "out", "clear", "a"); wire("foamGlow", "out", "clear", "b"); splat("foam", "foam", "clear", "alpha");
  out("clear", "out", "emissive");
  node("foamTint", "math.multiply", 300, -200, { b: [0.8, 0.8, 0.8] });
  wire("colors", "foamColor", "foamTint", "a");
  node("foamAlbedo", "math.multiply", 600, 0);
  wire("foamTint", "out", "foamAlbedo", "a"); splat("foam", "foam", "foamAlbedo", "b");
  out("foamAlbedo", "out", "baseColor");
  node("roughness", "math.mix", 600, 520, { a: 0.08, b: 1 });
  wire("foam", "foam", "roughness", "alpha");
  out("roughness", "out", "roughness");
  constant("noEnvironment", 600, 640, 0);
  out("noEnvironment", "out", "environmentInfluence");
  out("noEnvironment", "out", "metallic");
  // Without the scene copy, the deep or reflecting water covers the background; with it the water is opaque.
  node("cover", "math.max", 0, 760);
  wire("depth", "fade", "cover", "a"); wire("reflection", "fresnel", "cover", "b");
  node("covered", "math.max", 300, 820);
  wire("cover", "out", "covered", "a"); wire("foam", "foam", "covered", "b");
  node("opaque", "math.mix", 600, 820, { b: 1 });
  wire("covered", "out", "opaque", "a"); wire("scene", "available", "opaque", "alpha");
  node("opacity", "math.multiply", 900, 820);
  wire("opaque", "out", "opacity", "a"); wire("colors", "opacity", "opacity", "b");
  out("opacity", "out", "opacity");
  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}
