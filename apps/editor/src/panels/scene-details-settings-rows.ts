import {
  ENVIRONMENT_SOURCES,
  actorCameraComponent,
  createDefaultSceneSettings,
  normalizeSceneFogSettings,
  type EnvironmentSource,
  type ProjectDocument,
  type SerializedScene,
} from "@haptic/core";
import {
  assetRowIdentity,
  classRowIdentity,
  type AssetPickerEntry,
  type ClassPickerEntry,
  type PropertyRow,
} from "@haptic/editor-kit";
import { sceneActorDisplayLabel } from "../lib/scene-actor-entries";

/** Scene rows shown inside the Environment Lighting section. */
export const ENVIRONMENT_ROW_IDS = new Set(["scene-environment-source", "scene-environment-texture"]);

/** What the Inspector's Scene Settings rows read and write. */
export interface SceneDetailsSettingsRowsInput {
  scene: SerializedScene;
  projectDocument: ProjectDocument | null;
  classEntries: readonly ClassPickerEntry[];
  pickerAssets: readonly AssetPickerEntry[];
  mutate: (next: SerializedScene) => void;
  setEnvTexturePickOpen: (open: boolean) => void;
  setCameraPickerOpen: (open: boolean) => void;
}

/**
 * The Scene Settings rows of a world Scene, and the subset a Scene Layer
 * shows, which adds Enable Physics and labels its Layer Camera rows Layer
 * Width, Layer Height and Camera Location.
 */
export function sceneDetailsSettingsRows(input: SceneDetailsSettingsRowsInput): {
  settingsRows: PropertyRow[];
  overlaySettingsRows: PropertyRow[];
} {
  const { scene, projectDocument, classEntries, pickerAssets, mutate, setEnvTexturePickOpen, setCameraPickerOpen } = input;
  const defaults = createDefaultSceneSettings();
  const settingsRows: PropertyRow[] = [
    {
      kind: "text",
      id: "scene-name",
      label: "Name",
      value: scene.name,
      onChange: (name) => mutate({ ...scene, name }),
    },
    {
      kind: "asset",
      id: "scene-game-instance-class",
      label: "Game Instance",
      value: projectDocument?.settings.gameInstanceClass ?? null,
      placeholder: "None",
      disabled: true,
      onPick: () => {},
      onChange: () => {},
      ...classRowIdentity(
        classEntries.find(
          (entry) => entry.id === projectDocument?.settings.gameInstanceClass,
        ),
        projectDocument?.settings.gameInstanceClass,
      ),
    },
    {
      kind: "enum",
      id: "scene-viewport-mode",
      label: "Viewport",
      value: scene.viewportMode,
      options: [
        { value: "3d", label: "3D" },
        { value: "2d", label: "2D" },
      ],
      onChange: (mode) =>
        mutate({ ...scene, viewportMode: mode === "2d" ? "2d" : "3d" }),
    },
    {
      kind: "enum",
      id: "scene-physics-world",
      label: "Physics World",
      value: scene.settings.physicsWorld,
      options: [
        { value: "3d", label: "3D (Havok)" },
        { value: "2d", label: "2D (Rapier)" },
      ],
      onChange: (world) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            physicsWorld: world === "2d" ? "2d" : "3d",
          },
        }),
    },
    {
      kind: "color",
      id: "scene-environment-color",
      label: "Environment",
      value: scene.settings.environmentColor,
      defaultValue: defaults.environmentColor,
      onChange: (environmentColor) =>
        mutate({
          ...scene,
          settings: { ...scene.settings, environmentColor },
        }),
    },
    {
      kind: "boolean",
      id: "scene-fog",
      label: "Fog",
      description: "Distance fog. For light scattering, use Volumetric Fog in Project Settings > Rendering > Post Processing.",
      value: scene.settings.fogEnabled,
      defaultValue: defaults.fogEnabled,
      onChange: (fogEnabled) =>
        mutate({ ...scene, settings: { ...scene.settings, fogEnabled } }),
    },
    ...(scene.settings.fogEnabled
      ? [
          {
            kind: "enum" as const,
            id: "scene-fog-mode",
            label: "Fog Mode",
            description: "Linear fades between Start and End. Exponential modes use Density; Exponential Squared builds more gradually nearby.",
            value: scene.settings.fogMode,
            defaultValue: defaults.fogMode,
            options: [
              { value: "linear", label: "Linear" },
              { value: "exponential", label: "Exponential" },
              { value: "exponentialSquared", label: "Exponential Squared" },
            ],
            onChange: (fogMode: string) =>
              mutate({
                ...scene,
                settings: {
                  ...scene.settings,
                  ...normalizeSceneFogSettings({ ...scene.settings, fogMode }),
                },
              }),
          },
          {
            kind: "color" as const,
            id: "scene-fog-color",
            label: "Fog Color",
            value: scene.settings.fogColor,
            defaultValue: defaults.fogColor,
            onChange: (fogColor: typeof scene.settings.fogColor) =>
              mutate({
                ...scene,
                settings: { ...scene.settings, fogColor },
              }),
          },
          ...(scene.settings.fogMode === "linear"
            ? [
                {
                  kind: "number" as const,
                  id: "scene-fog-start",
                  label: "Fog Start",
                  description: "Distance from the camera where fog begins. Moving beyond End also moves End.",
                  unit: "scene units",
                  value: scene.settings.fogStart,
                  defaultValue: defaults.fogStart,
                  min: 0,
                  onChange: (fogStart: number) =>
                    mutate({
                      ...scene,
                      settings: {
                        ...scene.settings,
                        ...normalizeSceneFogSettings({ ...scene.settings, fogStart }),
                      },
                    }),
                },
                {
                  kind: "number" as const,
                  id: "scene-fog-end",
                  label: "Fog End",
                  description: "Distance where fog reaches full color. Moving before Start also moves Start.",
                  unit: "scene units",
                  value: scene.settings.fogEnd,
                  defaultValue: defaults.fogEnd,
                  min: 0.01,
                  onChange: (fogEnd: number) =>
                    mutate({
                      ...scene,
                      settings: {
                        ...scene.settings,
                        ...normalizeSceneFogSettings({
                          ...scene.settings,
                          fogStart: Math.min(scene.settings.fogStart, fogEnd - 0.01),
                          fogEnd,
                        }),
                      },
                    }),
                },
              ]
            : [
                {
                  kind: "number" as const,
                  id: "scene-fog-density",
                  label: "Fog Density",
                  description: "Higher values obscure nearby objects. Zero leaves distance fog invisible.",
                  value: scene.settings.fogDensity,
                  defaultValue: defaults.fogDensity,
                  min: 0,
                  precision: 6,
                  sensitivity: 0.0001,
                  onChange: (fogDensity: number) =>
                    mutate({
                      ...scene,
                      settings: { ...scene.settings, fogDensity },
                    }),
                },
              ]),
        ]
      : []),
    {
      kind: "enum",
      id: "scene-environment-source",
      label: "Environment Source",
      description: "What lights surfaces with image-based lighting. Skybox uses the scene's visible Skybox; Texture uses an imported environment cube.",
      value: scene.settings.environmentSource,
      options: [
        { value: "none", label: "None" },
        { value: "skybox", label: "Skybox" },
        { value: "texture", label: "Texture" },
      ],
      onChange: (source) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            environmentSource: ENVIRONMENT_SOURCES.includes(source as EnvironmentSource)
              ? (source as EnvironmentSource)
              : "none",
          },
        }),
    },
    ...(scene.settings.environmentSource === "texture"
      ? [
          {
            kind: "asset" as const,
            id: "scene-environment-texture",
            label: "Environment Texture",
            value: scene.settings.environmentTextureGuid,
            placeholder: "None",
            onPick: () => setEnvTexturePickOpen(true),
            onChange: (environmentTextureGuid: string | null) =>
              mutate({
                ...scene,
                settings: { ...scene.settings, environmentTextureGuid },
              }),
            ...assetRowIdentity(
              pickerAssets.find(
                (asset) => asset.guid === scene.settings.environmentTextureGuid,
              ),
            ),
          },
        ]
      : []),
    defaultCameraRow(scene, mutate, setCameraPickerOpen),
    ...layerCameraRows(scene, mutate),
    {
      kind: "boolean",
      id: "scene-editor-joystick",
      label: "Joystick",
      value: scene.settings.editorJoystickEnabled,
      defaultValue: defaults.editorJoystickEnabled,
      onChange: (editorJoystickEnabled) =>
        mutate({
          ...scene,
          settings: { ...scene.settings, editorJoystickEnabled },
        }),
    },
    ...(scene.viewportMode === "2d" ? stackZOrderRows(scene, mutate) : []),
    {
      kind: "vector3",
      id: "scene-gravity",
      label: "Gravity",
      value: scene.settings.gravity,
      defaultValue: defaults.gravity,
      onChange: (gravity) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            gravity: [gravity[0], gravity[1], gravity[2]],
          },
        }),
    },
    {
      kind: "number",
      id: "scene-snap-translate",
      label: "Snap Step",
      value: scene.settings.grid.snapTranslate,
      defaultValue: defaults.grid.snapTranslate,
      onChange: (snapTranslate) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            grid: { ...scene.settings.grid, snapTranslate },
          },
        }),
    },
    {
      kind: "number",
      id: "scene-tile-size",
      label: "Tile Size",
      value: scene.settings.grid.tileSize,
      defaultValue: defaults.grid.tileSize,
      onChange: (tileSize) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            grid: { ...scene.settings.grid, tileSize },
          },
        }),
    },
    {
      kind: "number",
      id: "scene-tile-subdivisions",
      label: "Tile Subdivisions",
      value: scene.settings.grid.tileSubdivisions,
      defaultValue: defaults.grid.tileSubdivisions,
      onChange: (tileSubdivisions) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            grid: {
              ...scene.settings.grid,
              tileSubdivisions: Math.max(1, Math.round(tileSubdivisions)),
            },
          },
        }),
    },
  ];

  const layerPhysicsRow: PropertyRow = {
    kind: "boolean",
    id: "scene-layer-physics",
    label: "Enable Physics",
    description: "Each instance simulates Rigid Bodies and Colliders in its own 2D world with this Gravity. Off: no physics world; bodies stay where scripts place them and collision events do not fire.",
    value: scene.settings.layerPhysicsEnabled === true,
    defaultValue: false,
    onChange: (layerPhysicsEnabled) =>
      mutate({
        ...scene,
        settings: { ...scene.settings, layerPhysicsEnabled },
      }),
  };
  const layerTickOnPauseRow: PropertyRow = {
    kind: "boolean",
    id: "scene-layer-tick-on-pause",
    label: "Tick On Pause",
    description: "While the game is paused, every actor in this layer and its Scene Layer Script keep ticking, whatever their own Tick On Pause.",
    value: scene.settings.layerTickOnPause === true,
    defaultValue: false,
    onChange: (layerTickOnPause) =>
      mutate({
        ...scene,
        settings: { ...scene.settings, layerTickOnPause },
      }),
  };
  const row = (id: string) => settingsRows.find((entry) => entry.id === id)!;
  const [layerLocation, layerWidth, layerHeight] = layerCameraRows(scene, mutate);
  // A Scene Layer's canvas is its camera's view: Layer Width and Height, and where its Layer Camera starts.
  const overlaySettingsRows: PropertyRow[] = [
    row("scene-name"),
    layerPhysicsRow,
    layerTickOnPauseRow,
    row("scene-gravity"),
    { ...layerWidth!, label: "Layer Width" },
    { ...layerHeight!, label: "Layer Height" },
    { ...layerLocation!, label: "Camera Location" },
  ];

  return { settingsRows, overlaySettingsRows };
}

/**
 * Default Camera: a placed actor Play possesses when the Scene starts. Its
 * status says when Play starts on the Layer Camera instead (no Camera
 * component, or the actor is gone).
 */
function defaultCameraRow(
  scene: SerializedScene,
  mutate: (next: SerializedScene) => void,
  setCameraPickerOpen: (open: boolean) => void,
): PropertyRow {
  const actorId = scene.settings.defaultCameraActorId;
  const actor = actorId ? scene.actors.find((entry) => entry.id === actorId) : undefined;
  return {
    kind: "asset",
    id: "scene-default-camera",
    label: "Default Camera",
    description: "The placed actor Play views through when the Scene starts. None starts on the Layer Camera.",
    value: actorId,
    displayLabel: sceneActorDisplayLabel(scene, actorId),
    displayType: actor?.classId,
    visual: actor ? { classId: actor.classId, family: "class" } : undefined,
    placeholder: "None",
    ...(actorId && !actor ? { status: "This actor is no longer in the Scene, so Play starts on the Layer Camera." }
      : actor && !actorCameraComponent(actor) ? { status: "This actor has no Camera component, so Play starts on the Layer Camera." }
        : {}),
    onPick: () => setCameraPickerOpen(true),
    onChange: () =>
      mutate({
        ...scene,
        settings: { ...scene.settings, defaultCameraActorId: null },
      }),
  };
}

/** 2D only: Stack New Actors, and the Z-Order the next new actor takes while it is on. */
function stackZOrderRows(
  scene: SerializedScene,
  mutate: (next: SerializedScene) => void,
): PropertyRow[] {
  const defaults = createDefaultSceneSettings();
  return [
    {
      kind: "boolean",
      id: "scene-stack-z-order-2d",
      label: "Stack New Actors",
      description: "Each actor you place, drag in, paste or duplicate takes Next Z-Order, which then goes up by one. Off: new actors take Z-Order 0.",
      value: scene.settings.stackZOrder2D,
      defaultValue: defaults.stackZOrder2D,
      onChange: (stackZOrder2D) =>
        mutate({ ...scene, settings: { ...scene.settings, stackZOrder2D } }),
    },
    ...(scene.settings.stackZOrder2D
      ? [
          {
            kind: "number" as const,
            id: "scene-next-z-order-2d",
            label: "Next Z-Order",
            value: scene.settings.nextZOrder2D,
            defaultValue: defaults.nextZOrder2D,
            onChange: (order: number) =>
              mutate({
                ...scene,
                settings: { ...scene.settings, nextZOrder2D: Number.isFinite(order) ? Math.round(order) : 0 },
              }),
          },
        ]
      : []),
  ];
}

/** The Layer Camera's start: where it looks (the orange outline's centre) and the view it frames at zoom 1. */
function layerCameraRows(
  scene: SerializedScene,
  mutate: (next: SerializedScene) => void,
): PropertyRow[] {
  const defaults = createDefaultSceneSettings();
  const bounds = scene.settings.cameraBounds2D;
  return [
    {
      kind: "vector3",
      id: "scene-camera-location",
      label: "Layer Camera Location",
      value: [scene.settings.cameraLocation2D[0], scene.settings.cameraLocation2D[1], 0],
      defaultValue: [defaults.cameraLocation2D[0], defaults.cameraLocation2D[1], 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) =>
        mutate({
          ...scene,
          settings: { ...scene.settings, cameraLocation2D: [x, y] },
        }),
    },
    {
      kind: "number",
      id: "scene-camera-bounds-width",
      label: "Layer Camera Width",
      value: bounds.width,
      defaultValue: defaults.cameraBounds2D.width,
      onChange: (width) =>
        mutate({
          ...scene,
          settings: { ...scene.settings, cameraBounds2D: { ...bounds, width } },
        }),
    },
    {
      kind: "number",
      id: "scene-camera-bounds-height",
      label: "Layer Camera Height",
      value: bounds.height,
      defaultValue: defaults.cameraBounds2D.height,
      onChange: (height) =>
        mutate({
          ...scene,
          settings: { ...scene.settings, cameraBounds2D: { ...bounds, height } },
        }),
    },
  ];
}
