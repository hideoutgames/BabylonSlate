import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/**
 * The User Interface domain's shape and progress nodes, as GLSL functions (the compiler builds GLSL only). Pixels are
 * the drawn target's, positions have their origin at the element's bottom left, y up.
 *
 * Shapes: `distance` is signed, in pixels, negative inside. Fill = saturate(0.5 − distance): one pixel of antialiasing
 * centred on the edge. Border = fill − saturate(0.5 − distance − width): the ring of Border Width just inside the
 * edge, antialiased on both sides, exactly 0 for a width of 0.
 */
export const USER_INTERFACE_SHAPE_GLSL = `
float hapticUiRoundedRectangleDistance(vec2 position, vec2 size, vec4 radius) {
  vec2 halfSize = 0.5 * abs(size);
  vec2 p = position - 0.5 * size;
  // Top left, top right, bottom right, bottom left; each at most half the shorter side.
  float r = p.x > 0.0 ? (p.y > 0.0 ? radius.y : radius.z) : (p.y > 0.0 ? radius.x : radius.w);
  r = clamp(r, 0.0, min(halfSize.x, halfSize.y));
  vec2 q = abs(p) - halfSize + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float hapticUiEllipseDistance(vec2 position, vec2 size) {
  vec2 axes = max(0.5 * abs(size), vec2(1e-4));
  vec2 p = position - 0.5 * size;
  // The implicit ellipse over its gradient: exact for a circle and at the edge, approximate away from it.
  float k0 = length(p / axes);
  float k1 = length(p / (axes * axes));
  return k1 > 1e-6 ? k0 * (k0 - 1.0) / k1 : -min(axes.x, axes.y);
}
vec3 hapticUiShape(float distance, float border) {
  float fill = clamp(0.5 - distance, 0.0, 1.0);
  return vec3(fill, fill - clamp(0.5 - distance - max(border, 0.0), 0.0, 1.0), distance);
}
`;

/**
 * Progress masks over a UV, 1 over the filled part, antialiased over one pixel at each edge (the pixel's size in the
 * mask's own measure, from screen derivatives taken before any selection), exactly 0 at Progress ≤ 0 and exactly 1 at
 * Progress ≥ 1.
 *
 * Linear: t = dot(uv − 0.5, d) / (|d.x| + |d.y|) + 0.5 along Direction d (a zero direction counts as (1, 0)), filled
 * where t < Progress: saturate((Progress − t) / pixel + 0.5).
 *
 * Radial: the turn about the UV centre from Start Angle, clockwise from up, filled where it is below Progress. The
 * pixel's size in turns comes from d(atan(x, y)) = (y dx − x dy) / |p|², which has no seam; turns past the middle of
 * the gap count back from the start, so both edges antialias: saturate(min(t, Progress − t) / pixel + 0.5).
 */
export const USER_INTERFACE_PROGRESS_GLSL = `
float hapticUiProgressMask(float progress, float mask) {
  return progress <= 0.0 ? 0.0 : (progress >= 1.0 ? 1.0 : mask);
}
float hapticUiLinearProgress(vec2 uv, float progress, vec2 direction) {
  vec2 d = direction.x == 0.0 && direction.y == 0.0 ? vec2(1.0, 0.0) : direction;
  float t = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  float pixel = max(length(vec2(dFdx(t), dFdy(t))), 1e-6);
  return hapticUiProgressMask(progress, clamp((progress - t) / pixel + 0.5, 0.0, 1.0));
}
float hapticUiRadialProgress(vec2 uv, float progress, float startAngle) {
  vec2 p = uv - 0.5;
  vec2 px = dFdx(p);
  vec2 py = dFdy(p);
  float turnsPerRadian = 0.15915494309189535;
  float pixel = max(length(vec2(p.y * px.x - p.x * px.y, p.y * py.x - p.x * py.y)) * turnsPerRadian / max(dot(p, p), 1e-12), 1e-6);
  float turn = fract(atan(p.x, p.x == 0.0 && p.y == 0.0 ? 1.0 : p.y) * turnsPerRadian - startAngle / 360.0);
  float t = turn > 0.5 * (1.0 + progress) ? turn - 1.0 : turn;
  return hapticUiProgressMask(progress, clamp(min(t, progress - t) / pixel + 0.5, 0.0, 1.0));
}
`;

const DERIVATIVES_EXTENSION = "#extension GL_OES_standard_derivatives : enable";

function input(point: NodeMaterialConnectionPoint, fallback: string): string {
  return point.isConnected ? point.associatedVariableName : fallback;
}

/**
 * Rounded Rectangle and Ellipse: Fill, Border and Distance (Pixels) of a shape of Size at Position, both in pixels.
 * The compiler wires Element Position and Element Size into an unwired Position or Size. Binds nothing.
 */
export class UserInterfaceShapeBlock extends NodeMaterialBlock {
  readonly shape: "roundedRectangle" | "ellipse";
  constructor(name: string, shape: "roundedRectangle" | "ellipse" = "roundedRectangle") {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.shape = shape;
    this.registerInput("position", Types.Vector2);
    this.registerInput("size", Types.Vector2);
    this.registerInput("radius", Types.Vector4, true);
    this.registerInput("border", Types.Float, true);
    this.registerOutput("fill", Types.Float);
    this.registerOutput("borderMask", Types.Float);
    this.registerOutput("distance", Types.Float);
  }
  get position() { return this._inputs[0]!; }
  get size() { return this._inputs[1]!; }
  get radius() { return this._inputs[2]!; }
  get border() { return this._inputs[3]!; }
  get fill() { return this._outputs[0]!; }
  get borderMask() { return this._outputs[1]!; }
  get distance() { return this._outputs[2]!; }
  override getClassName(): string { return "UserInterfaceShapeBlock"; }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitFunction("hapticUiShape", USER_INTERFACE_SHAPE_GLSL, "// User Interface shapes");
    const position = this.position.associatedVariableName, size = this.size.associatedVariableName;
    const distance = this.shape === "ellipse"
      ? `hapticUiEllipseDistance(${position}, ${size})`
      : `hapticUiRoundedRectangleDistance(${position}, ${size}, ${input(this.radius, "vec4(8.0)")})`;
    const shape = state._getFreeVariableName("uiShape");
    state.compilationString += `${state._declareLocalVar(shape, Types.Vector3)} = hapticUiShape(${distance}, ${input(this.border, "0.0")});\n`;
    state.compilationString += `${state._declareOutput(this.fill)} = ${shape}.x;\n`;
    state.compilationString += `${state._declareOutput(this.borderMask)} = ${shape}.y;\n`;
    state.compilationString += `${state._declareOutput(this.distance)} = ${shape}.z;\n`;
    return this;
  }
}
RegisterClass("BABYLON.UserInterfaceShapeBlock", UserInterfaceShapeBlock);

/**
 * Linear Progress (`uv`, `progress`, `direction`) and Radial Progress (`uv`, `progress`, `startAngle` in degrees): the
 * Mask of the filled part. The compiler wires Element UV into an unwired UV. Binds nothing.
 */
export class UserInterfaceProgressBlock extends NodeMaterialBlock {
  readonly kind: "linear" | "radial";
  constructor(name: string, kind: "linear" | "radial" = "linear") {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.kind = kind;
    this.registerInput("uv", Types.Vector2);
    this.registerInput("progress", Types.Float, true);
    // Direction (Linear) or Start Angle (Radial).
    this.registerInput(kind === "radial" ? "startAngle" : "direction", kind === "radial" ? Types.Float : Types.Vector2, true);
    this.registerOutput("mask", Types.Float);
  }
  get uv() { return this._inputs[0]!; }
  get progress() { return this._inputs[1]!; }
  get shaping() { return this._inputs[2]!; }
  get mask() { return this._outputs[0]!; }
  override getClassName(): string { return "UserInterfaceProgressBlock"; }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitExtension("derivatives", DERIVATIVES_EXTENSION);
    state._emitFunction("hapticUiProgress", USER_INTERFACE_PROGRESS_GLSL, "// User Interface progress");
    const progress = input(this.progress, "0.5");
    const call = this.kind === "radial"
      ? `hapticUiRadialProgress(${this.uv.associatedVariableName}, ${progress}, ${input(this.shaping, "0.0")})`
      : `hapticUiLinearProgress(${this.uv.associatedVariableName}, ${progress}, ${input(this.shaping, "vec2(1.0, 0.0)")})`;
    state.compilationString += `${state._declareOutput(this.mask)} = ${call};\n`;
    return this;
  }
}
RegisterClass("BABYLON.UserInterfaceProgressBlock", UserInterfaceProgressBlock);
