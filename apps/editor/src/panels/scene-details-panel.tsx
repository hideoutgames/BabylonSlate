import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useState } from "react";
import {
  PanelFrame,
  PropertyGrid,
  SearchSheet,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  createDefaultSceneSettings,
  findActor,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import {
  ADDABLE_COMPONENT_CLASSES,
  defaultPropertiesFor,
} from "./add-component-catalog";

const MESH_KINDS = ["box", "sphere", "cylinder", "plane", "ground"];

function componentPropertyRows(
  actor: SerializedActor,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
): PropertyRow[] {
  return Object.entries(component.properties).map(([key, value]) => {
    const id = `${actor.id}-${component.id}-${key}`;
    if (typeof value === "number") {
      return {
        kind: "number",
        id,
        label: key,
        value,
        onChange: (next) => update(key, next),
      };
    }
    if (typeof value === "boolean") {
      return {
        kind: "boolean",
        id,
        label: key,
        value,
        onChange: (next) => update(key, next),
      };
    }
    if (key === "meshKind") {
      return {
        kind: "enum",
        id,
        label: key,
        value: String(value ?? "box"),
        options: MESH_KINDS.map((kind) => ({ value: kind, label: kind })),
        onChange: (next) => update(key, next),
      };
    }
    if (Array.isArray(value) && value.length === 3) {
      return {
        kind: "vector3",
        id,
        label: key,
        value: value as [number, number, number],
        onChange: (next) => update(key, next),
      };
    }
    return {
      kind: "text",
      id,
      label: key,
      value: value === null || value === undefined ? "" : String(value),
      onChange: (next) => update(key, next === "" ? null : next),
    };
  });
}

export function SceneDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange } = useDocuments();
  const { selectedActorIds } = useSceneEditing();
  const [addComponentOpen, setAddComponentOpen] = useState(false);

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;
  const actorId = selectedActorIds[0] ?? null;
  const actor = scene && actorId ? (findActor(scene, actorId) ?? null) : null;

  const mutate = useCallback(
    (next: SerializedScene) => {
      void applySceneChange(documentId, next);
    },
    [applySceneChange, documentId],
  );

  const updateActor = useCallback(
    (update: (actor: SerializedActor) => SerializedActor) => {
      if (!scene || !actorId) return;
      mutate({
        ...scene,
        actors: scene.actors.map((entry) =>
          entry.id === actorId ? update(entry) : entry,
        ),
      });
    },
    [actorId, mutate, scene],
  );

  if (!scene) {
    return (
      <PanelFrame title="Details" data-testid="scene-details-panel">
        <p className="p-4 text-sm text-muted-foreground">Open a scene.</p>
      </PanelFrame>
    );
  }

  if (!actor) {
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
        kind: "text",
        id: "scene-game-instance-class",
        label: "Game instance class",
        value: scene.settings.gameInstanceClass ?? "",
        onChange: (gameInstanceClass) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              gameInstanceClass: gameInstanceClass.trim() || null,
            },
          }),
      },
      {
        kind: "enum",
        id: "scene-viewport-mode",
        label: "Default viewport mode",
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
        label: "Physics world",
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
        label: "Environment color",
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
        value: scene.settings.fogEnabled,
        defaultValue: defaults.fogEnabled,
        onChange: (fogEnabled) =>
          mutate({ ...scene, settings: { ...scene.settings, fogEnabled } }),
      },
      {
        kind: "vector3",
        id: "scene-gravity",
        label: "Gravity",
        value: scene.settings.gravity,
        defaultValue: defaults.gravity,
        onChange: (gravity) =>
          mutate({ ...scene, settings: { ...scene.settings, gravity } }),
      },
      {
        kind: "number",
        id: "scene-fixed-timestep",
        label: "Fixed timestep (ms)",
        value: scene.settings.fixedTimestepMs,
        defaultValue: defaults.fixedTimestepMs,
        onChange: (fixedTimestepMs) =>
          mutate({
            ...scene,
            settings: { ...scene.settings, fixedTimestepMs },
          }),
      },
      {
        kind: "number",
        id: "scene-snap-translate",
        label: "Snap step",
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
        label: "Tile size",
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
        label: "Tile subdivisions",
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
        label: "2D camera width",
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
        label: "2D camera height",
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

    return (
      <PanelFrame title="Details" data-testid="scene-details-panel">
        <PropertyGrid
          title="Scene settings"
          rows={settingsRows}
          data-testid="scene-settings-grid"
        />
      </PanelFrame>
    );
  }

  const transformRows: PropertyRow[] = [
    {
      kind: "text",
      id: "actor-name",
      label: "Name",
      value: actor.name,
      onChange: (name) => updateActor((entry) => ({ ...entry, name })),
    },
    {
      kind: "vector3",
      id: "actor-position",
      label: "Position",
      value: actor.transform.position,
      defaultValue: [0, 0, 0],
      onChange: (position) =>
        updateActor((entry) => ({
          ...entry,
          transform: { ...entry.transform, position },
        })),
    },
    {
      kind: "number",
      id: "actor-rotation-x",
      label: "Rotation X",
      value: actor.transform.rotation[0],
      defaultValue: 0,
      onChange: (rx) =>
        updateActor((entry) => ({
          ...entry,
          transform: {
            ...entry.transform,
            rotation: [
              rx,
              entry.transform.rotation[1],
              entry.transform.rotation[2],
              entry.transform.rotation[3],
            ],
          },
        })),
    },
    {
      kind: "number",
      id: "actor-rotation-y",
      label: "Rotation Y",
      value: actor.transform.rotation[1],
      defaultValue: 0,
      onChange: (ry) =>
        updateActor((entry) => ({
          ...entry,
          transform: {
            ...entry.transform,
            rotation: [
              entry.transform.rotation[0],
              ry,
              entry.transform.rotation[2],
              entry.transform.rotation[3],
            ],
          },
        })),
    },
    {
      kind: "number",
      id: "actor-rotation-z",
      label: "Rotation Z",
      value: actor.transform.rotation[2],
      defaultValue: 0,
      onChange: (rz) =>
        updateActor((entry) => ({
          ...entry,
          transform: {
            ...entry.transform,
            rotation: [
              entry.transform.rotation[0],
              entry.transform.rotation[1],
              rz,
              entry.transform.rotation[3],
            ],
          },
        })),
    },
    {
      kind: "number",
      id: "actor-rotation-w",
      label: "Rotation W",
      value: actor.transform.rotation[3],
      defaultValue: 1,
      onChange: (rw) =>
        updateActor((entry) => ({
          ...entry,
          transform: {
            ...entry.transform,
            rotation: [
              entry.transform.rotation[0],
              entry.transform.rotation[1],
              entry.transform.rotation[2],
              rw,
            ],
          },
        })),
    },
    {
      kind: "vector3",
      id: "actor-scale",
      label: "Scale",
      value: actor.transform.scale,
      defaultValue: [1, 1, 1],
      onChange: (scale) =>
        updateActor((entry) => ({
          ...entry,
          transform: { ...entry.transform, scale },
        })),
    },
    {
      kind: "boolean",
      id: "actor-visible",
      label: "Visible",
      value: actor.visible,
      defaultValue: true,
      onChange: (visible) => updateActor((entry) => ({ ...entry, visible })),
    },
    {
      kind: "boolean",
      id: "actor-locked",
      label: "Locked",
      value: actor.locked,
      defaultValue: false,
      onChange: (locked) => updateActor((entry) => ({ ...entry, locked })),
    },
  ];

  return (
    <PanelFrame
      title="Details"
      data-testid="scene-details-panel"
      toolbar={
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 min-w-11"
          onClick={() => setAddComponentOpen(true)}
          data-testid="details-add-component"
        >
          Add component
        </Button>
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        <PropertyGrid
          title={actor.name}
          rows={transformRows}
          data-testid="actor-transform-grid"
        />
        {actor.components.map((component, index) => (
          <div
            key={component.id}
            className="mx-2 rounded-md border border-border"
            data-testid={`component-card-${component.id}`}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
              <span className="truncate text-sm font-medium">
                {component.classId}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 min-w-11 text-xs"
                  disabled={index === 0}
                  aria-label={`Move ${component.classId} up`}
                  onClick={() =>
                    updateActor((entry) => {
                      const components = [...entry.components];
                      const [moved] = components.splice(index, 1);
                      components.splice(index - 1, 0, moved!);
                      return { ...entry, components };
                    })
                  }
                  data-testid={`component-up-${component.id}`}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 min-w-11 text-xs"
                  aria-label={`Remove ${component.classId}`}
                  onClick={() =>
                    updateActor((entry) => ({
                      ...entry,
                      components: entry.components.filter(
                        (candidate) => candidate.id !== component.id,
                      ),
                    }))
                  }
                  data-testid={`component-remove-${component.id}`}
                >
                  Remove
                </Button>
              </div>
            </div>
            <PropertyGrid
              rows={componentPropertyRows(actor, component, (property, value) =>
                updateActor((entry) => ({
                  ...entry,
                  components: entry.components.map((candidate) =>
                    candidate.id === component.id
                      ? {
                          ...candidate,
                          properties: {
                            ...candidate.properties,
                            [property]: value,
                          },
                        }
                      : candidate,
                  ),
                })),
              )}
            />
          </div>
        ))}
      </div>
      <SearchSheet
        open={addComponentOpen}
        onOpenChange={setAddComponentOpen}
        title="Add component"
        items={ADDABLE_COMPONENT_CLASSES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
        }))}
        onSelect={(classId) =>
          updateActor((entry) => ({
            ...entry,
            components: [
              ...entry.components,
              {
                id: `${entry.id}-component-${entry.components.length + 1}`,
                classId,
                properties: defaultPropertiesFor(
                  classId,
                  scene.settings.physicsWorld,
                ),
              },
            ],
          }))
        }
        data-testid="add-component-sheet"
      />
    </PanelFrame>
  );
}
