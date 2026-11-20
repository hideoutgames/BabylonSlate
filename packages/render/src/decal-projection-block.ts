import { VertexOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/vertexOutputBlock";
import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import type { MaterialPlumbing } from "./material-block-registry";

/**
 * Per-decal instance attributes beside Babylon's thin-instance world rows (`world0`..`world3`): the inverse world rows,
 * the decal's Tint and Opacity (rgb, a), and its cosine of Fade Angle (y). The decal pass fills them
 * (`decal-pass.ts`).
 */
export const DECAL_INSTANCE_ATTRIBUTES = ["decalInv0", "decalInv1", "decalInv2", "decalInv3", "decalTintOpacity", "decalParams"] as const;

/**
 * The pass's own uniforms. Not Babylon's `view` / `viewProjection`: its floating origin rewrites those by name from the
 * Scene's own camera, and the pass uploads its camera's matrices itself, already relative to the eye.
 */
export const DECAL_PASS_UNIFORMS = {
  viewProjection: "decalViewProjection",
  invViewProjection: "decalInvViewProjection",
  view: "decalView",
  invViewport: "decalInvViewport",
  depthRange: "decalDepthRange",
  reverseDepth: "decalReverseDepth",
  cameraPosition: "decalCameraPosition",
} as const;

/** The resolved scene depth the decal reconstructs its surface from. */
export const DECAL_SCENE_DEPTH_SAMPLER = "decalSceneDepth";

const WORLD_ROWS = ["world0", "world1", "world2", "world3"];
const VARYINGS = {
  invWorld: "vDecalInvWorld",
  projAxis: "vDecalProjAxis",
  tangent: "vDecalTangent",
  tintOpacity: "vDecalTintOpacity",
  params: "vDecalParams",
  origin: "vDecalOrigin",
} as const;

function declareAttribute(state: NodeMaterialBuildState, name: string, type: string): void {
  if (state.attributes.includes(name)) return;
  state.attributes.push(name);
  state._attributeDeclaration += `attribute ${type} ${name};\n`;
}

/**
 * The Decal domain's projection, which the compiler adds to every Decal Material and no graph authors. The vertex stage
 * draws the decal's box (a unit cube, thin-instanced with its world rows, `decalViewProjection`); the fragment stage
 * reads the resolved scene depth at the pixel, rebuilds the surface point there (relative to the floating origin's
 * eye, as every other draw), discards it outside the box, and gives the graph the surface's world position and normal,
 * the decal's projected UV (its local X and Z, 0 to 1), a tangent along its local X, the camera's position and view
 * direction, the decal's origin, its fade (Fade Angle and the box's ends) and its Tint and Opacity.
 *
 * Everything is written inline in `main`: no helper function, and so no early return. ANGLE's Direct3D 11 back end has
 * crashed the GPU process linking a decal program whose helper returned early.
 */
export class DecalProjectionBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.VertexAndFragment);
    this.registerOutput("clipPosition", Types.Vector4, NodeMaterialBlockTargets.Vertex);
    this.registerOutput("worldPosition", Types.Vector4, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("worldNormal", Types.Vector4, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("normal", Types.Vector3, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("tangent", Types.Vector3, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("uv", Types.Vector2, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("cameraPosition", Types.Vector3, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("viewDirection", Types.Vector3, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("viewPosition", Types.Vector4, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("origin", Types.Vector3, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("fade", Types.Float, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("tint", Types.Color3, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("opacity", Types.Float, NodeMaterialBlockTargets.Fragment);
  }

  override getClassName(): string {
    return "DecalProjectionBlock";
  }

  get clipPosition(): NodeMaterialConnectionPoint { return this._outputs[0]!; }
  /** The surface point under the pixel, eye-relative under Large World Rendering. */
  get worldPosition(): NodeMaterialConnectionPoint { return this._outputs[1]!; }
  /** The surface's geometric normal, facing the viewer, w 0. */
  get worldNormal(): NodeMaterialConnectionPoint { return this._outputs[2]!; }
  get normal(): NodeMaterialConnectionPoint { return this._outputs[3]!; }
  /** The decal's local X on the surface, unit length. */
  get tangent(): NodeMaterialConnectionPoint { return this._outputs[4]!; }
  get uv(): NodeMaterialConnectionPoint { return this._outputs[5]!; }
  get cameraPosition(): NodeMaterialConnectionPoint { return this._outputs[6]!; }
  get viewDirection(): NodeMaterialConnectionPoint { return this._outputs[7]!; }
  /** The surface point in view space, for the scene's fog. */
  get viewPosition(): NodeMaterialConnectionPoint { return this._outputs[8]!; }
  get origin(): NodeMaterialConnectionPoint { return this._outputs[9]!; }
  /** Fade Angle times the fade at the box's projection ends, 0 to 1. */
  get fade(): NodeMaterialConnectionPoint { return this._outputs[10]!; }
  /** The decal's Tint, linear. */
  get tint(): NodeMaterialConnectionPoint { return this._outputs[11]!; }
  get opacity(): NodeMaterialConnectionPoint { return this._outputs[12]!; }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    if (state.target === NodeMaterialBlockTargets.Fragment) this.buildFragment(state);
    else this.buildVertex(state);
    return this;
  }

  private declareVertexInputs(state: NodeMaterialBuildState): void {
    declareAttribute(state, "position", "vec3");
    for (const name of WORLD_ROWS) declareAttribute(state, name, "vec4");
    for (const name of DECAL_INSTANCE_ATTRIBUTES) declareAttribute(state, name, "vec4");
    state._emitUniformFromString(DECAL_PASS_UNIFORMS.viewProjection, Types.Matrix);
  }

  private buildVertex(state: NodeMaterialBuildState): void {
    this.declareVertexInputs(state);
    if (!this.clipPosition.hasEndpoints) return;
    state.compilationString += `${state._declareOutput(this.clipPosition)} = ${DECAL_PASS_UNIFORMS.viewProjection} * (mat4(${WORLD_ROWS.join(", ")}) * vec4(position, 1.0));\n`;
  }

  private buildFragment(state: NodeMaterialBuildState): void {
    const vertex = state._vertexState;
    this.declareVertexInputs(vertex);
    // The vertex stage hands over the decal's rows; the fragment never reads a vertex local.
    const varyings: Array<[string, Types, string]> = [
      [VARYINGS.invWorld, Types.Matrix, "mat4(decalInv0, decalInv1, decalInv2, decalInv3)"],
      [VARYINGS.projAxis, Types.Vector3, "normalize(world1.xyz)"],
      [VARYINGS.tangent, Types.Vector3, "normalize(world0.xyz)"],
      [VARYINGS.tintOpacity, Types.Vector4, "decalTintOpacity"],
      [VARYINGS.params, Types.Vector4, "decalParams"],
      [VARYINGS.origin, Types.Vector3, "world3.xyz"],
    ];
    for (const [name, type, value] of varyings) {
      if (vertex._emitVaryingFromString(name, type)) vertex.compilationString += `${name} = ${value};\n`;
      state._emitVaryingFromString(name, type);
    }
    const u = DECAL_PASS_UNIFORMS;
    state._emitUniformFromString(u.invViewProjection, Types.Matrix);
    state._emitUniformFromString(u.view, Types.Matrix);
    state._emitUniformFromString(u.invViewport, Types.Vector2);
    state._emitUniformFromString(u.depthRange, Types.Vector2);
    state._emitUniformFromString(u.reverseDepth, Types.Float);
    state._emitUniformFromString(u.cameraPosition, Types.Vector3);
    state._emit2DSampler(DECAL_SCENE_DEPTH_SAMPLER);
    state._emitFunctionFromInclude("helperFunctions", "");
    const declare = (output: NodeMaterialConnectionPoint, value: string) => output.hasEndpoints ? `${state._declareOutput(output)} = ${value};\n` : "";
    state.compilationString += decalProjectionFragmentSource()
      + declare(this.worldPosition, "vec4(decalSurface, 1.0)")
      + declare(this.worldNormal, "vec4(decalNormal, 0.0)")
      + declare(this.normal, "decalNormal")
      + declare(this.tangent, "decalTangent")
      + declare(this.uv, "decalLocal.xz + 0.5")
      + declare(this.cameraPosition, u.cameraPosition)
      + declare(this.viewDirection, `normalize(${u.cameraPosition} - decalSurface)`)
      + declare(this.viewPosition, `${u.view} * vec4(decalSurface, 1.0)`)
      + declare(this.origin, VARYINGS.origin)
      + declare(this.fade, "decalFade")
      + declare(this.tint, `toLinearSpace(${VARYINGS.tintOpacity}.rgb)`)
      + declare(this.opacity, `${VARYINGS.tintOpacity}.a`);
  }
}
RegisterClass("BABYLON.DecalProjectionBlock", DecalProjectionBlock);

/**
 * The projection's fragment code, inline in `main` (see `DecalProjectionBlock`). Declares `decalSurface`, `decalLocal`,
 * `decalNormal`, `decalTangent` and `decalFade`; discards the pixel where the sky shows, outside the box, or where the
 * surface has no normal.
 */
export function decalProjectionFragmentSource(): string {
  const u = DECAL_PASS_UNIFORMS, v = VARYINGS;
  return `
vec2 decalScreen = gl_FragCoord.xy * ${u.invViewport};
float decalDepth = texture2D(${DECAL_SCENE_DEPTH_SAMPLER}, decalScreen).r;
if (${u.reverseDepth} > 0.5 ? (decalDepth <= 0.0) : (decalDepth >= 1.0)) discard;
vec4 decalClip = vec4(decalScreen * 2.0 - 1.0, decalDepth * ${u.depthRange}.x + ${u.depthRange}.y, 1.0);
vec4 decalSurfaceH = ${u.invViewProjection} * decalClip;
if (abs(decalSurfaceH.w) < 1e-6) discard;
vec3 decalSurface = decalSurfaceH.xyz / decalSurfaceH.w;
vec3 decalLocal = (${v.invWorld} * vec4(decalSurface, 1.0)).xyz;
if (abs(decalLocal.x) > 0.5 || abs(decalLocal.y) > 0.5 || abs(decalLocal.z) > 0.5) discard;
vec3 decalNormal = cross(dFdx(decalSurface), dFdy(decalSurface));
float decalNormalLength = length(decalNormal);
if (decalNormalLength < 1e-6) discard;
decalNormal /= decalNormalLength;
// The visible surface faces the viewer: back along the pixel's ray, towards the near plane (perspective or orthographic).
vec4 decalNearH = ${u.invViewProjection} * vec4(decalClip.xy, (${u.reverseDepth} > 0.5 ? 1.0 : 0.0) * ${u.depthRange}.x + ${u.depthRange}.y, 1.0);
if (dot(decalNormal, decalNearH.xyz / decalNearH.w - decalSurface) < 0.0) decalNormal = -decalNormal;
// Fade Angle is the surface normal's angle from local +Y (the decal projects along -Y); 180 degrees never fades.
float decalFacing = dot(decalNormal, normalize(${v.projAxis}));
float decalCosFade = ${v.params}.y;
float decalFade = decalCosFade <= -0.9999 ? 1.0 : smoothstep(decalCosFade - 0.08, min(decalCosFade + 0.08, 1.0), decalFacing);
decalFade *= 1.0 - smoothstep(0.42, 0.5, abs(decalLocal.y));
vec3 decalTangent = ${v.tangent} - decalNormal * dot(${v.tangent}, decalNormal);
float decalTangentLength = length(decalTangent);
decalTangent = decalTangentLength > 1e-5 ? decalTangent / decalTangentLength : normalize(cross(decalNormal, abs(decalNormal.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
`;
}

/**
 * The Decal domain's plumbing: the projection block, its box's vertex output, and the values graph nodes read (World
 * Position and Normal, UV, Camera Position, View Direction, World Tangent, Object Position). The compiler reads the
 * fade, Tint and Opacity from `plumbing.decal`.
 */
export function createDecalPlumbing(
  name: string,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
): NodeMaterialBlock[] {
  const projection = new DecalProjectionBlock(`${name}_decalProjection`);
  const vertexOutput = new VertexOutputBlock(`${name}_vertexOutput`);
  projection.clipPosition.connectTo(vertexOutput.vector);
  created.push(projection, vertexOutput);
  plumbing.decal = projection;
  plumbing.worldPosition = projection.worldPosition;
  plumbing.worldNormal = projection.normal;
  plumbing.worldNormal4 = projection.worldNormal;
  plumbing.worldTangent = projection.tangent;
  plumbing.cameraPosition = projection.cameraPosition;
  plumbing.viewDirection = projection.viewDirection;
  plumbing.uv = projection.uv;
  plumbing.objectPosition = projection.origin;
  return [vertexOutput];
}
