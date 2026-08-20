import { Color3, Effect, LinesMesh, Mesh, MeshBuilder, Scene, ShaderMaterial, Vector3, type ArcRotateCamera } from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";
import { configureEditorRenderingGroups, RENDERING_GROUP } from "./sorting";

export const GRID_MESH_NAME = "__editor-grid__";
export const CAMERA_BOUNDS_MESH_NAME = "__editor-camera-bounds__";
/** Transparent sort: grid draws first among world-group alpha so helpers can sit on top. */
export const GRID_ALPHA_INDEX = 0;

const GRID_SHADER_NAME = "editorGrid";
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
  float alpha = max(major, minor * 0.45) * fade * viewFade;
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(color, alpha);
}
`;
}

export interface EditorGrid {
  readonly mesh: Mesh;
  readonly boundsMesh: LinesMesh | null;
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

  let mode: ViewportMode = options.mode ?? "3d";
  let spacing = options.spacing ?? 1;
  let subdivisions = Math.max(1, Math.round(options.subdivisions ?? 4));
  const color = options.color ?? new Color3(0.32, 0.34, 0.38);
  const minorColor = options.minorColor ?? new Color3(0.2, 0.21, 0.24);
  const camera = options.camera ?? null;
  const fadeOrigin = new Vector3();

  let boundsMesh: LinesMesh | null = null;
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
  };

  const applyPlane = () => {
    mesh.rotation.x = mode === "3d" ? Math.PI / 2 : 0;
    applyUniforms();
  };

  const buildBounds = () => {
    boundsMesh?.dispose();
    boundsMesh = null;
    // The game camera rectangle is a 2D framing aid; 3D has no equivalent.
    if (!requestedBounds || mode !== "2d") return;
    const halfWidth = requestedBounds.width / 2;
    const halfHeight = requestedBounds.height / 2;
    boundsMesh = MeshBuilder.CreateLines(
      CAMERA_BOUNDS_MESH_NAME,
      {
        points: [
          new Vector3(-halfWidth, -halfHeight, 0),
          new Vector3(halfWidth, -halfHeight, 0),
          new Vector3(halfWidth, halfHeight, 0),
          new Vector3(-halfWidth, halfHeight, 0),
          new Vector3(-halfWidth, -halfHeight, 0),
        ],
      },
      scene,
    );
    boundsMesh.color = new Color3(0.9, 0.7, 0.2);
    boundsMesh.isPickable = false;
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
      buildBounds();
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
    },
    setCameraBounds: (bounds) => {
      requestedBounds = bounds;
      buildBounds();
    },
    sync,
    dispose: () => {
      if (observer) scene.onBeforeRenderObservable.remove(observer);
      boundsMesh?.dispose();
      boundsMesh = null;
      material.dispose();
      mesh.dispose();
    },
  };
}
