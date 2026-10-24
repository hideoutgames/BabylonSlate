import { registerClusteredUnlitMaterial } from "./clustered-material-policy";
import { Color3, Effect, Mesh, MeshBuilder, Scene, ShaderLanguage, ShaderMaterial, ShaderStore, Vector2, Vector4, type AbstractMesh, type ArcRotateCamera } from "@babylonjs/core";
import type { ViewportMode } from "@haptic/core";
import { configureEditorRenderingGroups, RENDERING_GROUP } from "./sorting";
import { CAMERA_BOUNDS_MESH_NAME, GRID_MESH_NAME, markEditorHelperMesh } from "./helper-mesh";

export { CAMERA_BOUNDS_MESH_NAME, GRID_MESH_NAME };
/** Screen-space border width (px) for the orange 2D camera / 2DAnchor frame. */
export const CAMERA_BOUNDS_LINE_WIDTH = 2;
const CAMERA_BOUNDS_COLOR = new Color3(0.9, 0.7, 0.2);
/** Transparent sort: grid draws first among world-group alpha so helpers can sit on top. */
export const GRID_ALPHA_INDEX = 0;

const GRID_SHADER_NAME = "editorGrid";
const BOUNDS_SHADER_NAME = "editorCameraBounds";
const GRID_PLANE_OFFSET = 0.002;

/** Line colours are display-space; the world axes use the transform gizmo's axis colours. */
const GRID_MINOR_COLOR = new Color3(0.52, 0.53, 0.56);
const GRID_MAJOR_COLOR = new Color3(0.6, 0.61, 0.64);
const GRID_AXIS_X_COLOR = new Color3(0.86, 0.24, 0.22);
const GRID_AXIS_Y_COLOR = new Color3(0.22, 0.68, 0.38);
const GRID_AXIS_Z_COLOR = new Color3(0.28, 0.48, 0.86);

/**
 * Each grid level (minor, major, then ×10 steps of the major spacing) fades in
 * and gains emphasis from how large its cells are on screen, measured per
 * fragment. Zoom, distance and grazing angles all blend continuously.
 */
const GRID_LEVEL_STYLE = {
  /** A level is absent while its cells are this many pixels or smaller... */
  hiddenPx: 6,
  /** ...and fully present from this size. */
  presentPx: 32,
  /** Cells this large draw as major lines. */
  majorPx: 220,
  minorAlpha: 0.18,
  majorAlpha: 0.42,
  /** Widths under a pixel draw one pixel wide at proportionally lower alpha. */
  minorWidthPx: 0.75,
  majorWidthPx: 1,
  /** Share of the axis colour mixed into every line running along that axis. */
  axisTint: 0.1,
  axisWidthPx: 1.5,
  axisAlpha: 0.7,
  /** 3D: share of their width lines lose between the eye and the distance fade's end. */
  farThinning: 0.6,
} as const;

/** Macro levels above the major spacing, each ten times the last. */
const GRID_MACRO_LEVELS = 4;
/** 3D: the grid fades out between these multiples of the eye's height over the plane. */
const GRID_HEIGHT_FADE_START = 40;
const GRID_HEIGHT_FADE_END = 100;
/** 3D: the fade never starts closer than this many major cells, even with the eye on the plane. */
const GRID_MIN_FADE_CELLS = 24;

export interface EditorGridOptions {
  mode?: ViewportMode;
  /** Editor camera the plane follows; omit only in unit tests without a camera. */
  camera?: Pick<
    ArcRotateCamera,
    "target" | "radius" | "alpha" | "beta" | "orthoTop" | "orthoRight" | "maxZ"
  >;
  /** World units between major grid lines; the 2D tile size. */
  spacing?: number;
  /** Minor lines drawn between two major lines; 1 disables the minor grid. */
  subdivisions?: number;
  color?: Color3;
  minorColor?: Color3;
}

export interface GridCoverageCamera {
  radius: number;
  orthoTop: number | null;
  orthoRight: number | null;
}

/**
 * Snap the follow-plane origin to the grid under a point so the shader stays
 * world-aligned as the view moves.
 */
export function snapGridOrigin(
  mode: ViewportMode,
  target: { x: number; y: number; z: number },
  spacing: number,
): { x: number; y: number; z: number } {
  const step = spacing > 0 ? spacing : 1;
  const snap = (value: number) => Math.round(value / step) * step;
  if (mode === "2d") {
    return { x: snap(target.x), y: snap(target.y), z: 0 };
  }
  return { x: snap(target.x), y: 0, z: snap(target.z) };
}

/**
 * World size of the 2D follow plane so its edges stay off-screen.
 */
export function gridCoverageWorld(
  mode: ViewportMode,
  camera: GridCoverageCamera,
): number {
  if (mode === "2d") {
    const height = Math.abs(camera.orthoTop ?? 10);
    const width = Math.abs(camera.orthoRight ?? 10);
    return Math.max(width, height, 1) * 4;
  }
  return Math.max(camera.radius, 1) * 8;
}

export function gridEdgeFadeRange(coverage: number): {
  fadeStart: number;
  fadeEnd: number;
} {
  return { fadeStart: coverage * 0.35, fadeEnd: coverage * 0.5 };
}

/**
 * 3D distance fade around the eye: it scales with the eye's height over the
 * plane, so the grid reaches the same share of the view from any altitude.
 */
export function gridHeightFadeRange(
  height: number,
  spacing: number,
): { fadeStart: number; fadeEnd: number } {
  const reach = Math.max(Math.abs(height), (spacing * GRID_MIN_FADE_CELLS) / GRID_HEIGHT_FADE_START);
  return {
    fadeStart: reach * GRID_HEIGHT_FADE_START,
    fadeEnd: reach * GRID_HEIGHT_FADE_END,
  };
}

/** Fractional cell offset of `origin` on each macro level (×10, ×100, …), packed two levels per vec4. */
export function gridMacroOffsets(
  origin: { u: number; v: number },
  spacing: number,
): [number, number, number, number, number, number, number, number] {
  const offsets: number[] = [];
  let cell = spacing;
  for (let level = 0; level < GRID_MACRO_LEVELS; level++) {
    cell *= 10;
    const wrap = (value: number) => {
      const cells = value / cell;
      return cells - Math.floor(cells);
    };
    offsets.push(wrap(origin.u), wrap(origin.v));
  }
  return offsets as [number, number, number, number, number, number, number, number];
}

const glslFloat = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

function gridShaderConstants(language: "glsl" | "wgsl"): string {
  const style = GRID_LEVEL_STYLE;
  const entries: Array<[string, number]> = [
    ["LOG_HIDDEN_PX", Math.log(style.hiddenPx)],
    ["LOG_PRESENT_PX", Math.log(style.presentPx)],
    ["LOG_MAJOR_PX", Math.log(style.majorPx)],
    ["MINOR_ALPHA", style.minorAlpha],
    ["MAJOR_ALPHA", style.majorAlpha],
    ["MINOR_WIDTH", style.minorWidthPx],
    ["MAJOR_WIDTH", style.majorWidthPx],
    ["AXIS_TINT", style.axisTint],
    ["AXIS_WIDTH", style.axisWidthPx],
    ["AXIS_ALPHA", style.axisAlpha],
    ["FAR_THINNING", style.farThinning],
  ];
  return entries
    .map(([name, value]) =>
      language === "glsl"
        ? `const float ${name} = ${glslFloat(value)};`
        : `const ${name}: f32 = ${glslFloat(value)};`,
    )
    .join("\n");
}

function ensureGridShaders(): void {
  const vertexKey = `${GRID_SHADER_NAME}VertexShader`;
  const fragmentKey = `${GRID_SHADER_NAME}FragmentShader`;
  ShaderStore.ShadersStoreWGSL[vertexKey] = `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;
uniform gridExtent: f32;
varying vGridPosition: vec2f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vGridPosition = vertexInputs.position.xy * uniforms.gridExtent;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;
  ShaderStore.ShadersStoreWGSL[fragmentKey] = `
varying vGridPosition: vec2f;
uniform majorColor: vec3f;
uniform minorColor: vec3f;
uniform axisColorU: vec3f;
uniform axisColorV: vec3f;
uniform spacing: f32;
uniform subdivisions: f32;
uniform macroOffsets0: vec4f;
uniform macroOffsets1: vec4f;
uniform axisOrigin: vec2f;
uniform fadeCenter: vec2f;
uniform fadeStart: f32;
uniform fadeEnd: f32;
uniform gridVisible: f32;
uniform distanceThinning: f32;
${gridShaderConstants("wgsl")}
fn over(acc: vec4f, color: vec3f, alpha: f32) -> vec4f {
  return vec4f(color * alpha + acc.rgb * (1.0 - alpha), alpha + acc.a * (1.0 - alpha));
}
fn gridLevel(acc: vec4f, uv: vec2f, cellPx: vec2f, thin: f32) -> vec4f {
  let logCell = log(cellPx);
  let presence = smoothstep(vec2f(LOG_HIDDEN_PX), vec2f(LOG_PRESENT_PX), logCell);
  let emphasis = smoothstep(vec2f(LOG_PRESENT_PX), vec2f(LOG_MAJOR_PX), logCell);
  let width = mix(vec2f(MINOR_WIDTH), vec2f(MAJOR_WIDTH), emphasis) * thin;
  let drawWidth = max(width, vec2f(1.0));
  let distPx = abs(fract(uv - 0.5) - 0.5) * cellPx;
  let cover = clamp(drawWidth * 0.5 + 0.5 - distPx, vec2f(0.0), vec2f(1.0)) * (width / drawWidth);
  let alpha = cover * presence * mix(vec2f(MINOR_ALPHA), vec2f(MAJOR_ALPHA), emphasis);
  let alongV = mix(mix(uniforms.minorColor, uniforms.majorColor, emphasis.x), uniforms.axisColorV, AXIS_TINT);
  let alongU = mix(mix(uniforms.minorColor, uniforms.majorColor, emphasis.y), uniforms.axisColorU, AXIS_TINT);
  let color = (alongV * alpha.x + alongU * alpha.y) / max(alpha.x + alpha.y, 0.00001);
  return over(acc, color, max(alpha.x, alpha.y));
}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let p = fragmentInputs.vGridPosition;
  let dx = dpdx(p);
  let dy = dpdy(p);
  let unitsPerPx = max(vec2f(length(vec2f(dx.x, dy.x)), length(vec2f(dx.y, dy.y))), vec2f(0.0000001));
  let major = max(uniforms.spacing, 0.0001);
  let eyeDistance = length(p - uniforms.fadeCenter);
  let thin = 1.0 - uniforms.distanceThinning * FAR_THINNING * smoothstep(0.0, uniforms.fadeEnd, eyeDistance);
  var acc = vec4f(0.0);
  if (uniforms.subdivisions > 1.5) {
    let minor = major / uniforms.subdivisions;
    acc = gridLevel(acc, p / minor, vec2f(minor) / unitsPerPx, thin);
  }
  acc = gridLevel(acc, p / major, vec2f(major) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 10.0) + uniforms.macroOffsets0.xy, vec2f(major * 10.0) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 100.0) + uniforms.macroOffsets0.zw, vec2f(major * 100.0) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 1000.0) + uniforms.macroOffsets1.xy, vec2f(major * 1000.0) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 10000.0) + uniforms.macroOffsets1.zw, vec2f(major * 10000.0) / unitsPerPx, thin);
  let axisWidth = max(AXIS_WIDTH * thin, 1.0);
  let axisPx = abs(p - uniforms.axisOrigin) / unitsPerPx;
  let axisCover = clamp(vec2f(axisWidth * 0.5 + 0.5) - axisPx, vec2f(0.0), vec2f(1.0)) * AXIS_ALPHA;
  acc = over(acc, uniforms.axisColorV, axisCover.x);
  acc = over(acc, uniforms.axisColorU, axisCover.y);
  let fade = 1.0 - smoothstep(uniforms.fadeStart, uniforms.fadeEnd, eyeDistance);
  let alpha = acc.a * fade * uniforms.gridVisible;
  if (alpha < 0.003) { discard; }
  fragmentOutputs.color = vec4f(acc.rgb / max(acc.a, 0.00001), alpha);
}
`;
  Effect.ShadersStore[vertexKey] = `
attribute vec3 position;
uniform mat4 worldViewProjection;
uniform float gridExtent;
varying vec2 vGridPosition;
void main() {
  vGridPosition = position.xy * gridExtent;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
  // GLES 1.00 body: Babylon rewrites this for WebGL2. Do not declare
  // GL_OES_standard_derivatives — that extension is invalid in GLSL 300 es
  // and fails compile on typical CI Chromium. WebGL1 processors inject it
  // when they see fwidth.
  Effect.ShadersStore[fragmentKey] = `
varying vec2 vGridPosition;
uniform vec3 majorColor;
uniform vec3 minorColor;
uniform vec3 axisColorU;
uniform vec3 axisColorV;
uniform float spacing;
uniform float subdivisions;
uniform vec4 macroOffsets0;
uniform vec4 macroOffsets1;
uniform vec2 axisOrigin;
uniform vec2 fadeCenter;
uniform float fadeStart;
uniform float fadeEnd;
uniform float gridVisible;
uniform float distanceThinning;
${gridShaderConstants("glsl")}

vec4 over(vec4 acc, vec3 color, float alpha) {
  return vec4(color * alpha + acc.rgb * (1.0 - alpha), alpha + acc.a * (1.0 - alpha));
}

// One grid level: per axis, the level fades in and gains emphasis from its
// on-screen cell size. Lines of constant u run along v, and the reverse.
// Lines thinner than a pixel draw one pixel wide with their coverage scaled
// down, so they stay antialiased instead of breaking up.
vec4 gridLevel(vec4 acc, vec2 uv, vec2 cellPx, float thin) {
  vec2 logCell = log(cellPx);
  vec2 presence = smoothstep(vec2(LOG_HIDDEN_PX), vec2(LOG_PRESENT_PX), logCell);
  vec2 emphasis = smoothstep(vec2(LOG_PRESENT_PX), vec2(LOG_MAJOR_PX), logCell);
  vec2 width = mix(vec2(MINOR_WIDTH), vec2(MAJOR_WIDTH), emphasis) * thin;
  vec2 drawWidth = max(width, vec2(1.0));
  vec2 distPx = abs(fract(uv - 0.5) - 0.5) * cellPx;
  vec2 cover = clamp(drawWidth * 0.5 + 0.5 - distPx, 0.0, 1.0) * (width / drawWidth);
  vec2 alpha = cover * presence * mix(vec2(MINOR_ALPHA), vec2(MAJOR_ALPHA), emphasis);
  vec3 alongV = mix(mix(minorColor, majorColor, emphasis.x), axisColorV, AXIS_TINT);
  vec3 alongU = mix(mix(minorColor, majorColor, emphasis.y), axisColorU, AXIS_TINT);
  vec3 color = (alongV * alpha.x + alongU * alpha.y) / max(alpha.x + alpha.y, 0.00001);
  return over(acc, color, max(alpha.x, alpha.y));
}

void main() {
  vec2 p = vGridPosition;
  vec2 dx = dFdx(p);
  vec2 dy = dFdy(p);
  vec2 unitsPerPx = max(vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y))), vec2(0.0000001));
  float major = max(spacing, 0.0001);
  float eyeDistance = length(p - fadeCenter);
  // 3D lines thin out with distance from the eye, ahead of the fade.
  float thin = 1.0 - distanceThinning * FAR_THINNING * smoothstep(0.0, fadeEnd, eyeDistance);
  vec4 acc = vec4(0.0);
  if (subdivisions > 1.5) {
    float minor = major / subdivisions;
    acc = gridLevel(acc, p / minor, vec2(minor) / unitsPerPx, thin);
  }
  acc = gridLevel(acc, p / major, vec2(major) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 10.0) + macroOffsets0.xy, vec2(major * 10.0) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 100.0) + macroOffsets0.zw, vec2(major * 100.0) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 1000.0) + macroOffsets1.xy, vec2(major * 1000.0) / unitsPerPx, thin);
  acc = gridLevel(acc, p / (major * 10000.0) + macroOffsets1.zw, vec2(major * 10000.0) / unitsPerPx, thin);
  // World axes keep their colour at every zoom and never drop under a pixel.
  float axisWidth = max(AXIS_WIDTH * thin, 1.0);
  vec2 axisPx = abs(p - axisOrigin) / unitsPerPx;
  vec2 axisCover = clamp(axisWidth * 0.5 + 0.5 - axisPx, 0.0, 1.0) * AXIS_ALPHA;
  acc = over(acc, axisColorV, axisCover.x);
  acc = over(acc, axisColorU, axisCover.y);
  float fade = 1.0 - smoothstep(fadeStart, fadeEnd, eyeDistance);
  float alpha = acc.a * fade * gridVisible;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(acc.rgb / max(acc.a, 0.00001), alpha);
}
`;
}

function ensureBoundsShaders(): void {
  const vertexKey = `${BOUNDS_SHADER_NAME}VertexShader`;
  const fragmentKey = `${BOUNDS_SHADER_NAME}FragmentShader`;
  ShaderStore.ShadersStoreWGSL[vertexKey] = `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;
varying vBoundsPosition: vec2f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vBoundsPosition = vertexInputs.position.xy;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;
  ShaderStore.ShadersStoreWGSL[fragmentKey] = `
varying vBoundsPosition: vec2f;
uniform lineColor: vec3f;
uniform lineWidth: f32;
uniform boundsVisible: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let coord = fragmentInputs.vBoundsPosition;
  let deriv = fwidth(coord);
  let distX = (0.5 - abs(coord.x)) / max(deriv.x, 0.00000001);
  let distY = (0.5 - abs(coord.y)) / max(deriv.y, 0.00000001);
  let dist = min(distX, distY);
  if (uniforms.boundsVisible < 0.5 || dist < 0.0 || dist >= uniforms.lineWidth) { discard; }
  fragmentOutputs.color = vec4f(uniforms.lineColor, 1.0);
}
`;
  Effect.ShadersStore[vertexKey] = `
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec2 vBoundsPosition;
void main() {
  vBoundsPosition = position.xy;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
  Effect.ShadersStore[fragmentKey] = `
varying vec2 vBoundsPosition;
uniform vec3 lineColor;
uniform float lineWidth;
uniform float boundsVisible;

void main() {
  if (boundsVisible < 0.5) discard;
  vec2 deriv = fwidth(vBoundsPosition);
  float distX = (0.5 - abs(vBoundsPosition.x)) / max(deriv.x, 0.00000001);
  float distY = (0.5 - abs(vBoundsPosition.y)) / max(deriv.y, 0.00000001);
  float dist = min(distX, distY);
  if (dist < 0.0 || dist >= lineWidth) discard;
  gl_FragColor = vec4(lineColor, 1.0);
}
`;
}

export interface EditorGrid {
  readonly mesh: Mesh;
  readonly boundsMesh: AbstractMesh | null;
  setMode: (mode: ViewportMode) => void;
  setSpacing: (spacing: number) => void;
  setSubdivisions: (subdivisions: number) => void;
  setVisible: (visible: boolean) => void;
  /** Draw the rectangle the game camera will frame (2D only). */
  setCameraBounds: (bounds: { width: number; height: number } | null) => void;
  /** Snap/scale the plane to the live camera. Also runs each frame. */
  sync: () => void;
  dispose: () => void;
}

export function createEditorGrid(
  scene: Scene,
  options: EditorGridOptions = {},
): EditorGrid {
  ensureGridShaders();
  ensureBoundsShaders();

  let mode: ViewportMode = options.mode ?? "3d";
  let spacing = options.spacing ?? 1;
  let subdivisions = Math.max(1, Math.round(options.subdivisions ?? 4));
  const color = options.color ?? GRID_MAJOR_COLOR;
  const minorColor = options.minorColor ?? GRID_MINOR_COLOR;
  const camera = options.camera ?? null;

  let requestedBounds: { width: number; height: number } | null = null;
  let visible = true;

  const mesh = MeshBuilder.CreatePlane(
    GRID_MESH_NAME,
    { size: 1, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  mesh.isPickable = false;
  // Water contacts, captures and shadows must never treat the grid plane as world geometry.
  markEditorHelperMesh(mesh);
  mesh.doNotSyncBoundingInfo = true;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isVisible = true;
  mesh.visibility = visible ? 1 : 0;
  mesh.alphaIndex = GRID_ALPHA_INDEX;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  configureEditorRenderingGroups(scene);

  const material = new ShaderMaterial(
    `${GRID_MESH_NAME}-material`,
    scene,
    { vertex: GRID_SHADER_NAME, fragment: GRID_SHADER_NAME },
    {
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      attributes: ["position"],
      uniforms: [
        "worldViewProjection",
        "spacing",
        "subdivisions",
        "majorColor",
        "minorColor",
        "axisColorU",
        "axisColorV",
        "macroOffsets0",
        "macroOffsets1",
        "axisOrigin",
        "fadeCenter",
        "fadeStart",
        "fadeEnd",
        "gridExtent",
        "gridVisible",
        "distanceThinning",
      ],
      needAlphaBlending: true,
    },
  );
  registerClusteredUnlitMaterial(material);
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  mesh.material = material;

  // Grid colors are display-space. A Scene Linear view draws the grid into its
  // linear HDR scene color and encodes it once in the Display Color stage.
  let linear = scene.imageProcessingConfiguration.applyByPostProcess;
  const sceneColor = (value: Color3) => (linear ? value.toLinearSpace() : value);

  const applyUniforms = () => {
    material.setFloat("spacing", spacing);
    material.setFloat("subdivisions", subdivisions);
    material.setColor3("majorColor", sceneColor(color));
    material.setColor3("minorColor", sceneColor(minorColor));
    // The plane's u axis is world X; v is world Z in 3D and world Y in 2D.
    material.setColor3("axisColorU", sceneColor(GRID_AXIS_X_COLOR));
    material.setColor3("axisColorV", sceneColor(mode === "3d" ? GRID_AXIS_Z_COLOR : GRID_AXIS_Y_COLOR));
    material.setFloat("gridVisible", visible ? 1 : 0);
    // 2D fades at the frame edge, not with depth, so its lines keep their width.
    material.setFloat("distanceThinning", mode === "3d" ? 1 : 0);
  };

  const applyPlane = () => {
    mesh.rotation.x = mode === "3d" ? Math.PI / 2 : 0;
    applyUniforms();
  };

  const boundsMesh = MeshBuilder.CreatePlane(
    CAMERA_BOUNDS_MESH_NAME,
    { size: 1, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  boundsMesh.isPickable = false;
  markEditorHelperMesh(boundsMesh);
  boundsMesh.alwaysSelectAsActiveMesh = true;
  boundsMesh.isVisible = true;
  boundsMesh.visibility = 1;
  boundsMesh.alphaIndex = GRID_ALPHA_INDEX;
  boundsMesh.renderingGroupId = RENDERING_GROUP.foreground;
  boundsMesh.rotation.x = 0;

  const boundsMaterial = new ShaderMaterial(
    `${CAMERA_BOUNDS_MESH_NAME}-material`,
    scene,
    { vertex: BOUNDS_SHADER_NAME, fragment: BOUNDS_SHADER_NAME },
    {
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      attributes: ["position"],
      uniforms: [
        "worldViewProjection",
        "lineColor",
        "lineWidth",
        "boundsVisible",
      ],
      needAlphaBlending: true,
    },
  );
  registerClusteredUnlitMaterial(boundsMaterial);
  boundsMaterial.backFaceCulling = false;
  boundsMaterial.disableDepthWrite = true;
  const boundsDepth = boundsMaterial as { disableDepthCheck?: boolean };
  if ("disableDepthCheck" in boundsDepth) {
    boundsDepth.disableDepthCheck = true;
  }
  boundsMesh.material = boundsMaterial;

  const boundsDrawn = () => mode === "2d" && requestedBounds !== null;

  const applyBounds = () => {
    if (requestedBounds) {
      boundsMesh.scaling.set(requestedBounds.width, requestedBounds.height, 1);
    }
    boundsMaterial.setColor3("lineColor", sceneColor(CAMERA_BOUNDS_COLOR));
    boundsMaterial.setFloat("lineWidth", CAMERA_BOUNDS_LINE_WIDTH);
    boundsMaterial.setFloat("boundsVisible", boundsDrawn() ? 1 : 0);
    boundsMesh.isVisible = true;
    boundsMesh.alwaysSelectAsActiveMesh = true;
    boundsMesh.visibility = 1;
    boundsMesh.refreshBoundingInfo(false, false);
  };

  // The plane, its scale and the view uniforms follow from the mode, spacing
  // and camera. The inputs and placement of the last sync let an unchanged
  // frame (a parked camera) return without recomputing or rewriting.
  const applied = {
    valid: false, mode, spacing, x: 0, y: 0, z: 0, radius: 0, alpha: 0, beta: 0, maxZ: 0,
    orthoTop: null as number | null, orthoRight: null as number | null,
    px: 0, py: 0, pz: 0, scale: 0,
  };

  const sync = () => {
    if (!camera) return;
    const target = camera.target;
    if (applied.valid && applied.mode === mode && applied.spacing === spacing &&
      applied.x === target.x && applied.y === target.y && applied.z === target.z &&
      applied.radius === camera.radius && applied.alpha === camera.alpha && applied.beta === camera.beta &&
      applied.maxZ === camera.maxZ &&
      applied.orthoTop === camera.orthoTop && applied.orthoRight === camera.orthoRight &&
      mesh.position.x === applied.px && mesh.position.y === applied.py && mesh.position.z === applied.pz &&
      mesh.scaling.x === applied.scale && mesh.scaling.y === applied.scale && mesh.scaling.z === applied.scale) return;
    let coverage: number;
    let fadeStart: number;
    let fadeEnd: number;
    // Plane-local (u, v) of the fade centre; world X and Z (3D) or Y (2D).
    let center: { u: number; v: number };
    let origin: { u: number; v: number };
    if (mode === "2d") {
      const snapped = snapGridOrigin(mode, target, spacing);
      mesh.position.set(snapped.x, snapped.y, GRID_PLANE_OFFSET);
      origin = { u: snapped.x, v: snapped.y };
      center = { u: target.x - snapped.x, v: target.y - snapped.y };
      coverage = gridCoverageWorld(mode, camera);
      ({ fadeStart, fadeEnd } = gridEdgeFadeRange(coverage));
    } else {
      // The plane follows the eye, not the orbit target: a fly camera can
      // look out from far above, or far from, the point it orbits.
      const sinBeta = Math.sin(camera.beta);
      const eye = {
        x: target.x + camera.radius * Math.cos(camera.alpha) * sinBeta,
        y: target.y + camera.radius * Math.cos(camera.beta),
        z: target.z + camera.radius * Math.sin(camera.alpha) * sinBeta,
      };
      const height = Math.abs(eye.y - GRID_PLANE_OFFSET);
      ({ fadeStart, fadeEnd } = gridHeightFadeRange(height, spacing));
      // Fade out before the far clip plane can cut the grid off.
      const far = (camera.maxZ > 0 ? camera.maxZ : 10000) * 0.9;
      fadeEnd = Math.min(fadeEnd, Math.sqrt(Math.max(far * far - height * height, 1)));
      fadeStart = Math.min(fadeStart, fadeEnd * 0.5);
      const snapped = snapGridOrigin(mode, eye, spacing);
      mesh.position.set(snapped.x, GRID_PLANE_OFFSET, snapped.z);
      origin = { u: snapped.x, v: snapped.z };
      center = { u: eye.x - snapped.x, v: eye.z - snapped.z };
      coverage = (fadeEnd + spacing) * 2;
    }
    mesh.scaling.setAll(coverage);
    applied.valid = true;
    applied.mode = mode; applied.spacing = spacing;
    applied.x = target.x; applied.y = target.y; applied.z = target.z;
    applied.radius = camera.radius; applied.alpha = camera.alpha; applied.beta = camera.beta; applied.maxZ = camera.maxZ;
    applied.orthoTop = camera.orthoTop; applied.orthoRight = camera.orthoRight;
    applied.px = mesh.position.x; applied.py = mesh.position.y; applied.pz = mesh.position.z; applied.scale = coverage;
    // The plane origin is snapped to a major grid cell, so local coordinates
    // preserve world alignment without mixing absolute and floating positions.
    // Coarser levels and the world axes get their offsets from the origin here.
    const macro = gridMacroOffsets(origin, spacing);
    material.setFloat("gridExtent", coverage);
    material.setVector4("macroOffsets0", new Vector4(macro[0], macro[1], macro[2], macro[3]));
    material.setVector4("macroOffsets1", new Vector4(macro[4], macro[5], macro[6], macro[7]));
    material.setVector2("axisOrigin", new Vector2(-origin.u, -origin.v));
    material.setVector2("fadeCenter", new Vector2(center.u, center.v));
    material.setFloat("fadeStart", fadeStart);
    material.setFloat("fadeEnd", fadeEnd);
  };

  applyPlane();
  applyBounds();
  sync();

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (linear !== scene.imageProcessingConfiguration.applyByPostProcess) {
      linear = !linear;
      applyUniforms();
      applyBounds();
    }
    sync();
  });

  return {
    get mesh() {
      return mesh;
    },
    get boundsMesh() {
      return boundsMesh;
    },
    setMode: (next: ViewportMode) => {
      if (next === mode) return;
      mode = next;
      applyPlane();
      applyBounds();
      sync();
    },
    setSpacing: (next: number) => {
      if (next <= 0 || next === spacing) return;
      spacing = next;
      applyUniforms();
      sync();
    },
    setSubdivisions: (next: number) => {
      const rounded = Math.max(1, Math.round(next));
      if (rounded === subdivisions) return;
      subdivisions = rounded;
      applyUniforms();
    },
    setVisible: (next: boolean) => {
      visible = next;
      mesh.isVisible = true;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.visibility = next ? 1 : 0;
      material.setFloat("gridVisible", next ? 1 : 0);
      applyBounds();
    },
    setCameraBounds: (bounds) => {
      requestedBounds = bounds;
      applyBounds();
    },
    sync,
    dispose: () => {
      if (observer) scene.onBeforeRenderObservable.remove(observer);
      boundsMaterial.dispose();
      boundsMesh.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
