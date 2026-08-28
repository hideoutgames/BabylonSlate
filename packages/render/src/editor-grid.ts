import { Color3, Effect, Mesh, MeshBuilder, Scene, ShaderMaterial, Vector2, Vector3, type AbstractMesh, type ArcRotateCamera } from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";
import { configureEditorRenderingGroups, RENDERING_GROUP } from "./sorting";

export const GRID_MESH_NAME = "__editor-grid__";
export const CAMERA_BOUNDS_MESH_NAME = "__editor-camera-bounds__";
/** Screen-space border width (px) for the orange 2D camera / 2DAnchor frame. */
export const CAMERA_BOUNDS_LINE_WIDTH = 2;
const CAMERA_BOUNDS_COLOR = new Color3(0.9, 0.7, 0.2);
/** Transparent sort: grid draws first among world-group alpha so helpers can sit on top. */
export const GRID_ALPHA_INDEX = 0;

const GRID_SHADER_NAME = "editorGrid";
const BOUNDS_SHADER_NAME = "editorCameraBounds";
const GRID_PLANE_OFFSET = 0.002;
const GRID_LINE_WIDTH = 1.25;

/** Start dimming when this many major cells fit in the view half-extent. */
export const GRID_VIEW_FADE_START_CELLS = 28;
/** Hide the grid once this many major cells fit in the view half-extent. */
export const GRID_VIEW_FADE_END_CELLS = 100;

export interface EditorGridOptions {
  mode?: ViewportMode;
  /** Editor camera the plane follows; omit only in unit tests without a camera. */
  camera?: Pick<
    ArcRotateCamera,
    "target" | "radius" | "orthoTop" | "orthoRight"
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
 * Snap the follow-plane origin to the grid under the camera target so the
 * shader stays world-aligned as the view pans.
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
 * World size of the follow plane so its edges stay off-screen.
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 1 when the UV sample sits on the 2px screen-space border of the
 * camera-bounds plane, else 0. `fwidthU` / `fwidthV` are the UV change per
 * fragment (same as GLSL `fwidth(uv)`). Equivalent to
 * `cameraBoundsWorldBorderCoverage` for an origin-centered plane: a 16×9
 * rect keeps equal pixel thickness on horizontal and vertical edges.
 */
export function cameraBoundsBorderCoverage(
  uv: { x: number; y: number },
  fwidthU: number,
  fwidthV: number,
  lineWidth: number,
): number {
  const distX = Math.min(uv.x, 1 - uv.x) / Math.max(fwidthU, 1e-8);
  const distY = Math.min(uv.y, 1 - uv.y) / Math.max(fwidthV, 1e-8);
  return Math.min(distX, distY) < lineWidth ? 1 : 0;
}

/**
 * 1 when the world XY sample sits on the 2px screen-space border of the
 * camera-bounds plane (the fragment shader path). `half` is `width/2` ×
 * `height/2`; `fwidthX` / `fwidthY` match GLSL `fwidth(vWorldPos.xy)`.
 */
export function cameraBoundsWorldBorderCoverage(
  world: { x: number; y: number },
  half: { x: number; y: number },
  fwidthX: number,
  fwidthY: number,
  lineWidth: number,
): number {
  const distX = (half.x - Math.abs(world.x)) / Math.max(fwidthX, 1e-8);
  const distY = (half.y - Math.abs(world.y)) / Math.max(fwidthY, 1e-8);
  const dist = Math.min(distX, distY);
  return dist >= 0 && dist < lineWidth ? 1 : 0;
}

/** GLSL-style smoothstep so unit tests match the fragment edge fade. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Edge-fade alpha at a planar distance from the follow origin. */
export function gridEdgeFadeAlpha(
  fadeStart: number,
  fadeEnd: number,
  planarDist: number,
): number {
  return 1 - smoothstep(fadeStart, fadeEnd, planarDist);
}

function gridViewHalfExtent(
  mode: ViewportMode,
  camera: GridCoverageCamera,
): number {
  if (mode === "2d") {
    return Math.max(
      Math.abs(camera.orthoTop ?? 10),
      Math.abs(camera.orthoRight ?? 10),
    );
  }
  return Math.max(camera.radius, 0);
}

/**
 * 1 when the view still shows a useful grid; 0 when too many major cells
 * fit on screen (far zoom) and the lines would shimmer.
 */
export function gridViewFade(
  mode: ViewportMode,
  camera: GridCoverageCamera,
  spacing: number,
): number {
  const cell = Math.max(spacing, 0.0001);
  const cells = gridViewHalfExtent(mode, camera) / cell;
  if (cells <= GRID_VIEW_FADE_START_CELLS) return 1;
  if (cells >= GRID_VIEW_FADE_END_CELLS) return 0;
  return (
    1 -
    (cells - GRID_VIEW_FADE_START_CELLS) /
      (GRID_VIEW_FADE_END_CELLS - GRID_VIEW_FADE_START_CELLS)
  );
}

function ensureGridShaders(): void {
  const vertexKey = `${GRID_SHADER_NAME}VertexShader`;
  const fragmentKey = `${GRID_SHADER_NAME}FragmentShader`;
  Effect.ShadersStore[vertexKey] = `
attribute vec3 position;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vWorldPos;
void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
  // GLES 1.00 body: Babylon rewrites this for WebGL2. Do not declare
  // GL_OES_standard_derivatives — that extension is invalid in GLSL 300 es
  // and fails compile on typical CI Chromium. WebGL1 processors inject it
  // when they see fwidth.
  Effect.ShadersStore[fragmentKey] = `
varying vec3 vWorldPos;
uniform vec3 majorColor;
uniform vec3 minorColor;
uniform float spacing;
uniform float subdivisions;
uniform float fadeStart;
uniform float fadeEnd;
uniform vec3 fadeOrigin;
uniform float viewFade;
uniform float gridVisible;
uniform float mode2d;
uniform float lineWidth;

float gridLine(vec2 coord, float cell) {
  vec2 uv = coord / cell;
  vec2 wrapped = abs(fract(uv - 0.5) - 0.5);
  vec2 deriv = fwidth(uv);
  vec2 line = 1.0 - smoothstep(vec2(0.0), deriv * lineWidth, wrapped);
  return max(line.x, line.y);
}

void main() {
  vec2 coord = mode2d > 0.5 ? vWorldPos.xy : vWorldPos.xz;
  vec2 origin = mode2d > 0.5 ? fadeOrigin.xy : fadeOrigin.xz;
  float cell = max(spacing, 0.0001);
  float major = gridLine(coord, cell);
  float minor = subdivisions > 1.5
    ? gridLine(coord, cell / max(subdivisions, 1.0))
    : 0.0;
  float dist = length(coord - origin);
  float fade = 1.0 - smoothstep(fadeStart, fadeEnd, dist);
  vec3 color = mix(minorColor, majorColor, clamp(major, 0.0, 1.0));
  float alpha = max(major, minor * 0.45) * fade * viewFade * gridVisible;
  if (gridVisible < 0.5 || alpha < 0.02) discard;
  gl_FragColor = vec4(color, alpha);
}
`;
}

function ensureBoundsShaders(): void {
  const vertexKey = `${BOUNDS_SHADER_NAME}VertexShader`;
  const fragmentKey = `${BOUNDS_SHADER_NAME}FragmentShader`;
  Effect.ShadersStore[vertexKey] = `
attribute vec3 position;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vWorldPos;
void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
  Effect.ShadersStore[fragmentKey] = `
varying vec3 vWorldPos;
uniform vec3 lineColor;
uniform float lineWidth;
uniform float boundsVisible;
uniform vec2 boundsHalf;

void main() {
  if (boundsVisible < 0.5) discard;
  vec2 deriv = fwidth(vWorldPos.xy);
  float distX = (boundsHalf.x - abs(vWorldPos.x)) / max(deriv.x, 0.00000001);
  float distY = (boundsHalf.y - abs(vWorldPos.y)) / max(deriv.y, 0.00000001);
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
  const color = options.color ?? new Color3(0.32, 0.34, 0.38);
  const minorColor = options.minorColor ?? new Color3(0.2, 0.21, 0.24);
  const camera = options.camera ?? null;
  const fadeOrigin = new Vector3();

  let requestedBounds: { width: number; height: number } | null = null;
  let visible = true;

  const mesh = MeshBuilder.CreatePlane(
    GRID_MESH_NAME,
    { size: 1, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  mesh.isPickable = false;
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
      attributes: ["position"],
      uniforms: [
        "world",
        "worldViewProjection",
        "spacing",
        "subdivisions",
        "majorColor",
        "minorColor",
        "fadeStart",
        "fadeEnd",
        "fadeOrigin",
        "viewFade",
        "gridVisible",
        "mode2d",
        "lineWidth",
      ],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  mesh.material = material;

  const applyUniforms = () => {
    material.setFloat("spacing", spacing);
    material.setFloat("subdivisions", subdivisions);
    material.setColor3("majorColor", color);
    material.setColor3("minorColor", minorColor);
    material.setFloat("mode2d", mode === "2d" ? 1 : 0);
    material.setFloat("lineWidth", GRID_LINE_WIDTH);
    material.setFloat("gridVisible", visible ? 1 : 0);
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
      attributes: ["position"],
      uniforms: [
        "world",
        "worldViewProjection",
        "lineColor",
        "lineWidth",
        "boundsVisible",
        "boundsHalf",
      ],
      needAlphaBlending: true,
    },
  );
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
      boundsMaterial.setVector2(
        "boundsHalf",
        new Vector2(requestedBounds.width / 2, requestedBounds.height / 2),
      );
    }
    boundsMaterial.setColor3("lineColor", CAMERA_BOUNDS_COLOR);
    boundsMaterial.setFloat("lineWidth", CAMERA_BOUNDS_LINE_WIDTH);
    boundsMaterial.setFloat("boundsVisible", boundsDrawn() ? 1 : 0);
    boundsMesh.isVisible = true;
    boundsMesh.alwaysSelectAsActiveMesh = true;
    boundsMesh.visibility = 1;
    boundsMesh.refreshBoundingInfo(false, false);
  };

  const sync = () => {
    applyPlane();
    if (!camera) return;
    const origin = snapGridOrigin(mode, camera.target, spacing);
    if (mode === "2d") {
      mesh.position.set(origin.x, origin.y, GRID_PLANE_OFFSET);
    } else {
      mesh.position.set(origin.x, GRID_PLANE_OFFSET, origin.z);
    }
    const coverage = gridCoverageWorld(mode, camera);
    const { fadeStart, fadeEnd } = gridEdgeFadeRange(coverage);
    mesh.scaling.setAll(coverage);
    fadeOrigin.set(origin.x, origin.y, origin.z);
    material.setVector3("fadeOrigin", fadeOrigin);
    material.setFloat("fadeStart", fadeStart);
    material.setFloat("fadeEnd", fadeEnd);
    material.setFloat("viewFade", gridViewFade(mode, camera, spacing));
  };

  applyPlane();
  applyBounds();
  sync();

  const observer = scene.onBeforeRenderObservable.add(() => {
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
