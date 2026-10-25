import {
  ENVIRONMENT_SOURCES,
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
import { sceneComponentDisplayLabel } from "../lib/scene-component-entries";

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
 * shows, which adds Enable Physics and labels the 2D camera bounds Layer Width
 * and Layer Height.
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
    {
      kind: "asset",
      id: "scene-default-camera",
      label: "Default Camera",
      value: scene.settings.mainCameraComponentId,
      displayLabel: sceneComponentDisplayLabel(
        scene,
        scene.settings.mainCameraActorId,
        scene.settings.mainCameraComponentId,
      ),
      displayType: scene.settings.mainCameraComponentId
        ? "CameraComponent"
        : undefined,
      visual: scene.settings.mainCameraComponentId
        ? { classId: "CameraComponent", family: "class" }
        : undefined,
      placeholder: "None",
      onPick: () => setCameraPickerOpen(true),
      onChange: () =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            mainCameraActorId: null,
            mainCameraComponentId: null,
          },
        }),
    },
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
    {
      kind: "number",
      id: "scene-camera-bounds-width",
      label: "2D Camera Width",
      value: scene.settings.cameraBounds2D.width,
      defaultValue: defaults.cameraBounds2D.width,
      onChange: (width) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            cameraBounds2D: { ...scene.settings.cameraBounds2D, width },
          },
        }),
    },
    {
      kind: "number",
      id: "scene-camera-bounds-height",
      label: "2D Camera Height",
      value: scene.settings.cameraBounds2D.height,
      defaultValue: defaults.cameraBounds2D.height,
      onChange: (height) =>
        mutate({
          ...scene,
          settings: {
            ...scene.settings,
            cameraBounds2D: { ...scene.settings.cameraBounds2D, height },
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
  const overlaySettingsRows = settingsRows
    .filter(
      (row) =>
        row.id === "scene-name" ||
        row.id === "scene-gravity" ||
        row.id === "scene-camera-bounds-width" ||
        row.id === "scene-camera-bounds-height",
    )
    .flatMap((row) => {
      if (row.id === "scene-gravity") return [layerPhysicsRow, row];
      if (row.id === "scene-camera-bounds-width") {
        return [{ ...row, label: "Layer Width" }];
      }
      if (row.id === "scene-camera-bounds-height") {
        return [{ ...row, label: "Layer Height" }];
      }
      return [row];
    });

  return { settingsRows, overlaySettingsRows };
}
