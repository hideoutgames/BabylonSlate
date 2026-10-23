import { createDefaultMaterialDocument, type MaterialDocument, type MaterialGraphEdge, type MaterialGraphNode } from "./document";
import { materialPinDefaultPropertyKey } from "./pin-defaults";

/** The starter water Materials: one close to built-in water, and the least a water Material needs. */
export type WaterMaterialLook = "realistic" | "basic";

/**
 * A Surface Material for a Water asset's Custom Material, wired from the water nodes. Both move with the asset's waves
 * (Water Waves' Offset into World Position Offset, its Normal into Normal), so a body drawn with either matches what
 * floating objects ride, and both take the asset's colours (Water Colors), so the Water asset's Inspector still applies.
 *
 * - Realistic is lit and translucent, close to built-in water: the water's colour is emitted (what lies below through
 *   Shallow Color, absorbed toward Deep Color with depth, then the reflection by its Fresnel), foam is Foam Color, half glowing and half lit,
 *   and the scene's lights add the sun's highlight on the waves.
 * - Basic is only that: lit, opaque Deep Color on the moving waves, glossy (Roughness 0.08). The start
 *   of a look of your own.
 */
export function createWaterMaterialDocument(name: string, look: WaterMaterialLook): MaterialDocument {
  const doc = createDefaultMaterialDocument(name);
  doc.blendMode = look === "basic" ? "opaque" : "translucent";
  doc.shadingModel = "pbr";
  const nodes: MaterialGraphNode[] = [doc.nodes.find((node) => node.type === "output.surface")!];
  const edges: MaterialGraphEdge[] = [];
  const node = (id: string, type: string, x: number, y: number, defaults: Record<string, number | readonly number[]> = {}) => {
    const properties: Record<string, unknown> = {};
    for (const [pin, value] of Object.entries(defaults)) properties[materialPinDefaultPropertyKey(pin)] = typeof value === "number" ? [value] : [...value];
    nodes.push({ id, type, position: { x, y }, properties });
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
  output.position = { x: 1200, y: 0 };

  node("waves", "input.waterWaves", -800, -400);
  node("colors", "input.waterColors", -800, 0);
  out("waves", "offset", "worldPositionOffset");
  out("waves", "normal", "normal");

  if (look === "basic") {
    out("colors", "deepColor", "baseColor");
    node("roughness", "const.float", -400, 200);
    nodes[nodes.length - 1]!.properties.value = [0.08];
    out("roughness", "out", "roughness");
  } else {
    node("depth", "input.waterDepthFade", -800, 260);
    node("scene", "input.waterSceneColor", -800, 460);
    node("reflection", "input.waterReflection", -800, 700);
    node("foam", "input.waterFoam", -800, 940);
    // What lies below, through Shallow Color, absorbed toward Deep Color with depth; Deep Color where there is no copy.
    node("tint", "math.multiply", -400, 380);
    wire("scene", "color", "tint", "a"); wire("colors", "shallowColor", "tint", "b");
    node("below", "math.mix", -100, 200);
    wire("tint", "out", "below", "a"); wire("colors", "deepColor", "below", "b"); splat("depth", "fade", "below", "alpha");
    node("body", "math.mix", 200, 120);
    wire("colors", "deepColor", "body", "a"); wire("below", "out", "body", "b"); splat("scene", "available", "body", "alpha");
    node("water", "math.mix", 500, 200);
    wire("body", "out", "water", "a"); wire("reflection", "color", "water", "b"); splat("reflection", "fresnel", "water", "alpha");
    // Foam hides the water: half its colour glows, so it stays white in shade, and the rest is lit as rough albedo.
    node("foamGlow", "math.multiply", 500, 360, { b: [0.5, 0.5, 0.5] });
    wire("colors", "foamColor", "foamGlow", "a");
    node("clear", "math.mix", 800, 260);
    wire("water", "out", "clear", "a"); wire("foamGlow", "out", "clear", "b"); splat("foam", "foam", "clear", "alpha");
    out("clear", "out", "emissive");
    node("foamAlbedo", "math.multiply", 800, 0);
    wire("colors", "foamColor", "foamAlbedo", "a"); splat("foam", "foam", "foamAlbedo", "b");
    out("foamAlbedo", "out", "baseColor");
    node("roughness", "math.mix", 800, 520, { a: 0.08, b: 0.9 });
    wire("foam", "foam", "roughness", "alpha");
    out("roughness", "out", "roughness");
    node("noEnvironment", "const.float", 800, 640);
    nodes[nodes.length - 1]!.properties.value = [0];
    out("noEnvironment", "out", "environmentInfluence");
    out("noEnvironment", "out", "metallic");
    // Without the copy, the deep or reflecting water covers the background; with it the water is opaque.
    node("cover", "math.max", 200, 760);
    wire("depth", "fade", "cover", "a"); wire("reflection", "fresnel", "cover", "b");
    node("covered", "math.max", 500, 820);
    wire("cover", "out", "covered", "a"); wire("foam", "foam", "covered", "b");
    node("opaque", "math.mix", 800, 820, { b: 1 });
    wire("covered", "out", "opaque", "a"); wire("scene", "available", "opaque", "alpha");
    node("opacity", "math.multiply", 1000, 820);
    wire("opaque", "out", "opacity", "a"); wire("colors", "opacity", "opacity", "b");
    out("opacity", "out", "opacity");
  }
  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}
