import { createDefaultMaterialDocument, type MaterialDocument, type MaterialGraphEdge, type MaterialGraphNode } from "./document";
import { materialPinDefaultPropertyKey } from "./pin-defaults";

/** The looks a starter water Material is wired as: built-in water's Realistic and Painted. */
export type WaterMaterialLook = "realistic" | "painted";

/**
 * A Surface Material for a Water asset's Custom Material, wired from the water nodes so it starts close to built-in
 * water and every step can be edited: Water Waves displaces and shades the surface, Water Colors follows the asset's
 * colours, Water Depth Fade and Water Scene Color show what lies below, Water Reflection mirrors the sky and scene
 * objects by its Fresnel, and Water Foam paints whitecaps, shorelines and contacts.
 *
 * - Realistic is lit and translucent: the water's colour is emitted (what lies below through Shallow Color, absorbed
 *   toward Deep Color with depth, then the reflection by its Fresnel), foam is lit white albedo, and the scene's
 *   lights add the sun's highlight on the waves.
 * - Painted is unlit and translucent: depth in three flat bands from Shallow to Deep Color, crests lifted toward Shallow
 *   Color, the sky reflected in two soft steps, shallows showing the bed, and foam in crisp paint.
 */
export function createWaterMaterialDocument(name: string, look: WaterMaterialLook): MaterialDocument {
  const doc = createDefaultMaterialDocument(name);
  doc.blendMode = "translucent";
  doc.shadingModel = look === "painted" ? "unlit" : "pbr";
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
  node("depth", "input.waterDepthFade", -800, 260);
  node("scene", "input.waterSceneColor", -800, 460);
  node("reflection", "input.waterReflection", -800, 700);
  node("foam", "input.waterFoam", -800, 940);
  out("waves", "offset", "worldPositionOffset");

  if (look === "realistic") {
    out("waves", "normal", "normal");
    // What lies below, through Shallow Color, absorbed toward Deep Color with depth; Deep Color where there is no copy.
    node("tint", "math.multiply", -400, 380);
    wire("scene", "color", "tint", "a"); wire("colors", "shallowColor", "tint", "b");
    node("below", "math.mix", -100, 200);
    wire("tint", "out", "below", "a"); wire("colors", "deepColor", "below", "b"); splat("depth", "fade", "below", "alpha");
    node("body", "math.mix", 200, 120);
    wire("colors", "deepColor", "body", "a"); wire("below", "out", "body", "b"); splat("scene", "available", "body", "alpha");
    node("water", "math.mix", 500, 200);
    wire("body", "out", "water", "a"); wire("reflection", "color", "water", "b"); splat("reflection", "fresnel", "water", "alpha");
    // Foam hides the water and is lit as rough white albedo.
    node("clear", "math.mix", 800, 260, { b: [0, 0, 0] });
    wire("water", "out", "clear", "a"); splat("foam", "foam", "clear", "alpha");
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
  } else {
    // Depth in three flat bands from Shallow to Deep Color.
    node("bandScale", "math.multiply", -400, 200, { b: 3 });
    wire("depth", "fade", "bandScale", "a");
    node("bandRound", "math.round", -250, 200);
    wire("bandScale", "out", "bandRound", "value");
    node("bands", "math.divide", -100, 200, { b: 3 });
    wire("bandRound", "out", "bands", "a");
    node("bandColor", "math.mix", 100, 80);
    wire("colors", "shallowColor", "bandColor", "a"); wire("colors", "deepColor", "bandColor", "b"); splat("bands", "out", "bandColor", "alpha");
    // Crests lifted toward Shallow Color.
    node("crest", "math.smoothstep", -400, -300, { edgeA: 0.05, edgeB: 0.45 });
    wire("waves", "height", "crest", "value");
    node("crestLift", "math.multiply", -200, -300, { b: 0.55 });
    wire("crest", "out", "crestLift", "a");
    node("body", "math.mix", 300, -60);
    wire("bandColor", "out", "body", "a"); wire("colors", "shallowColor", "body", "b"); splat("crestLift", "out", "body", "alpha");
    // The sky in two soft steps of the Fresnel.
    node("skyStepA", "math.smoothstep", -400, 760, { edgeA: 0.06, edgeB: 0.09 });
    wire("reflection", "fresnel", "skyStepA", "value");
    node("skyStepB", "math.smoothstep", -400, 900, { edgeA: 0.25, edgeB: 0.28 });
    wire("reflection", "fresnel", "skyStepB", "value");
    node("skySteps", "math.add", -200, 820);
    wire("skyStepA", "out", "skySteps", "a"); wire("skyStepB", "out", "skySteps", "b");
    node("skyAmount", "math.multiply", 0, 820, { b: 0.3 });
    wire("skySteps", "out", "skyAmount", "a");
    node("sky", "math.mix", 500, 120);
    wire("body", "out", "sky", "a"); wire("reflection", "color", "sky", "b"); splat("skyAmount", "out", "sky", "alpha");
    // Shallows show the bed, tinted toward Shallow Color, where the pass has the scene copy.
    node("bed", "math.multiply", -400, 460);
    wire("scene", "color", "bed", "a"); wire("colors", "shallowColor", "bed", "b");
    node("clearShallows", "math.smoothstep", -100, 360, { edgeA: 0, edgeB: 0.45 });
    wire("depth", "fade", "clearShallows", "value");
    node("shallows", "math.mix", 700, 200);
    wire("bed", "out", "shallows", "a"); wire("sky", "out", "shallows", "b"); splat("clearShallows", "out", "shallows", "alpha");
    node("painted", "math.mix", 850, 120);
    wire("sky", "out", "painted", "a"); wire("shallows", "out", "painted", "b"); splat("scene", "available", "painted", "alpha");
    // Foam in crisp paint.
    node("foamPaint", "math.smoothstep", 300, 1000, { edgeA: 0.35, edgeB: 0.45 });
    wire("foam", "foam", "foamPaint", "value");
    node("color", "math.mix", 1000, 120);
    wire("painted", "out", "color", "a"); wire("colors", "foamColor", "color", "b"); splat("foamPaint", "out", "color", "alpha");
    out("color", "out", "baseColor");
    // Shallows thin out over the bed without the copy; with it the water is opaque.
    node("thin", "math.smoothstep", 300, 760, { edgeA: 0, edgeB: 0.35 });
    wire("depth", "fade", "thin", "value");
    node("covered", "math.max", 600, 820);
    wire("thin", "out", "covered", "a"); wire("foamPaint", "out", "covered", "b");
    node("opaque", "math.mix", 850, 820, { b: 1 });
    wire("covered", "out", "opaque", "a"); wire("scene", "available", "opaque", "alpha");
    node("opacity", "math.multiply", 1000, 820);
    wire("opaque", "out", "opacity", "a"); wire("colors", "opacity", "opacity", "b");
    out("opacity", "out", "opacity");
  }
  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}
