import type { Dispatch, ReactNode, SetStateAction } from "react";
import { RENDERING_SETTINGS_SECTIONS, type RenderingSceneContext } from "../components/rendering-settings-sections";
import {
  AssetPicker,
  AssetPickerControl,
  EntryListEditor,
  DisclosureSection,
  NumberField,
  PropertyGrid,
  SceneActorPicker,
  assetRowIdentity,
  selectedPickerIdentity,
  type AssetPickerEntry,
  type ClassPickerEntry,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  normalizeRenderEffectsOverrides,
  normalizeScenePostProcessStack,
  normalizeSceneLayerPostProcessStack,
  resolveRenderEffectsSettings,
  type ProjectDocument,
  type SerializedScene,
} from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import { Switch } from "@haptic/ui/components/switch";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { PostProcessPassList, type PostProcessPassPick } from "../components/post-process-pass-list";
import type { DocumentActions } from "../context/document-context-types";
import { sceneDefaultCameraEntries } from "../lib/scene-actor-entries";
import { ENVIRONMENT_ROW_IDS, sceneDetailsSettingsRows } from "./scene-details-settings-rows";

/** Inspector state and actions the Scene Settings sections read; the Inspector owns all of it. */
export interface SceneDetailsSettingsProps {
  scene: SerializedScene;
  overlay: boolean;
  projectDocument: ProjectDocument | null;
  mutate: (next: SerializedScene) => void;
  classEntries: ClassPickerEntry[];
  pickerAssets: AssetPickerEntry[];
  environmentPickerAssets: AssetPickerEntry[];
  postProcessPickerAssets: AssetPickerEntry[];
  postProcessEntries: ReturnType<typeof normalizeScenePostProcessStack>;
  matches: (label: string) => boolean;
  filterRows: (rows: PropertyRow[], section?: string) => PropertyRow[];
  overrideOpen: (id: string) => boolean;
  setOverrideOpen: (id: string, open: boolean) => void;
  noMatchingProperties: ReactNode;
  envTexturePickOpen: boolean;
  setEnvTexturePickOpen: Dispatch<SetStateAction<boolean>>;
  effectsLutPickOpen: boolean;
  setEffectsLutPickOpen: Dispatch<SetStateAction<boolean>>;
  cameraPickerOpen: boolean;
  setCameraPickerOpen: Dispatch<SetStateAction<boolean>>;
  postProcessPick: PostProcessPassPick;
  setPostProcessPick: Dispatch<SetStateAction<PostProcessPassPick>>;
  /** A Scene Layer shows the Project Settings Scene Layer post-processing, and edits it there. */
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  sceneLayerPick: "add" | number | null;
  setSceneLayerPick: Dispatch<SetStateAction<"add" | number | null>>;
}

/**
 * The Inspector with no actor selected: Scene Settings, Post-Process Passes,
 * the overrides of each Project Settings → Rendering section a Scene can
 * override (`RENDERING_SETTINGS_SECTIONS`) and Scene Layers, then their
 * pickers. Hook-free, so the Inspector's state survives a selection change.
 */
export function SceneDetailsSettings(props: SceneDetailsSettingsProps) {
  const {
    scene,
    overlay,
    projectDocument,
    mutate,
    classEntries,
    pickerAssets,
    environmentPickerAssets,
    postProcessPickerAssets,
    postProcessEntries,
    matches,
    filterRows,
    overrideOpen,
    setOverrideOpen,
    noMatchingProperties,
    envTexturePickOpen,
    setEnvTexturePickOpen,
    effectsLutPickOpen,
    setEffectsLutPickOpen,
    cameraPickerOpen,
    setCameraPickerOpen,
    postProcessPick,
    setPostProcessPick,
    sceneLayerPick,
    setSceneLayerPick,
    updateProjectSettings,
  } = props;
  const { settingsRows, overlaySettingsRows } = sceneDetailsSettingsRows({
    scene,
    projectDocument,
    classEntries,
    pickerAssets,
    mutate,
    setEnvTexturePickOpen,
    setCameraPickerOpen,
  });
  const stackAssetPicker = (
    guid: string,
    id: string,
    label: string,
    onPick: () => void,
  ) => {
    const asset = pickerAssets.find((entry) => entry.guid === guid);
    return (
      <Field className="min-w-0 gap-0">
        <FieldLabel className="sr-only" htmlFor={id}>
          {label}
        </FieldLabel>
        <AssetPickerControl value={guid}>
          <Button
            type="button"
            id={id}
            variant="outline"
            size="sm"
            className="w-full min-w-0 justify-start pointer-coarse:min-h-11"
            title={
              asset ? `${asset.name} — ${asset.path}` : `Missing Asset: ${guid}`
            }
            data-testid={id}
            onClick={onPick}
          >
            {selectedPickerIdentity(
              { ...assetRowIdentity(asset), displayType: undefined },
              "Missing Asset",
            )}
          </Button>
        </AssetPickerControl>
      </Field>
    );
  };

  const visibleSettingsRows = filterRows(
    overlay ? overlaySettingsRows : settingsRows.filter((row) => !ENVIRONMENT_ROW_IDS.has(row.id)),
    "Scene Settings",
  );
  const showPostProcess = overlay
    ? matches("Scene Layer Post-Processing Post-Process Passes Material Entry ID Enabled")
    : matches("Post-Process Passes Material Entry ID Enabled Scalable Resolution");
  const projectRender = projectDocument?.settings.render;
  const effectsOverrides = scene.settings.effectsOverrides ?? {};
  const setEffectsLut = (lutTextureGuid: string | null) =>
    mutate({ ...scene, settings: { ...scene.settings, effectsOverrides: normalizeRenderEffectsOverrides({
      ...effectsOverrides, colorGrading: { ...effectsOverrides.colorGrading, lutTextureGuid },
    }) } });
  const assetName = (guid: string | null) => (guid ? pickerAssets.find((entry) => entry.guid === guid)?.name ?? "Missing Asset" : "None");
  // The Project Settings → Rendering sections a Scene overrides, in their order there; none in a Scene Layer.
  const overrideSections = overlay ? [] : RENDERING_SETTINGS_SECTIONS.filter((section) =>
    section.scene && section.available?.(projectRender) !== false && matches(`${section.title} ${section.scene.searchText}`));
  const overrideContext: RenderingSceneContext = {
    render: projectRender,
    settings: scene.settings,
    setSettings: (settings) => mutate({ ...scene, settings }),
    environmentRows: <PropertyGrid rows={settingsRows.filter((row) => ENVIRONMENT_ROW_IDS.has(row.id))} />,
    lutName: assetName,
    lutControl: (control) => {
      const guid = resolveRenderEffectsSettings(projectRender?.effects, effectsOverrides).colorGrading.lutTextureGuid;
      const asset = guid ? pickerAssets.find((entry) => entry.guid === guid) : undefined;
      return (
        <AssetPickerControl value={guid}>
          <Button
            type="button"
            id={control.id}
            variant="outline"
            size="sm"
            className="w-full min-w-0 justify-start pointer-coarse:min-h-11"
            aria-describedby={control.describedBy}
            disabled={control.disabled}
            data-testid={control.id}
            onClick={() => setEffectsLutPickOpen(true)}
          >
            {selectedPickerIdentity(assetRowIdentity(asset))}
          </Button>
        </AssetPickerControl>
      );
    },
  };
  const showSceneLayers = !overlay && matches("Scene Layers Z-Order Enabled");
  return (
    <>
      {visibleSettingsRows.length > 0 ? (
        <PropertyGrid
          title="Scene Settings"
          rows={visibleSettingsRows}
          data-testid="scene-settings-grid"
        />
      ) : null}
      {showPostProcess ? (
        <div className="px-2 pb-3">
          {overlay ? (
            // Not a per-layer override: the Project Setting itself, so an edit here is an edit there.
            <PostProcessPassList
              idPrefix="scene-layer-post-process"
              title="Scene Layer Post-Processing"
              hint="Project Settings: every Scene Layer shares these passes, drawn over all layers together."
              entries={projectDocument?.settings.sceneLayerPostProcessStack ?? []}
              onChange={(entries) => updateProjectSettings({ sceneLayerPostProcessStack: normalizeSceneLayerPostProcessStack(entries) })}
              assets={pickerAssets}
              materialAssets={postProcessPickerAssets}
              pick={postProcessPick}
              onPickChange={setPostProcessPick}
            />
          ) : (
            <PostProcessPassList
              idPrefix="scene-post-process"
              title="Post-Process Passes"
              entries={postProcessEntries}
              onChange={(entries) =>
                mutate({ ...scene, settings: { ...scene.settings, postProcessStack: normalizeScenePostProcessStack(entries) } })}
              assets={pickerAssets}
              materialAssets={postProcessPickerAssets}
              scalable
              pick={postProcessPick}
              onPickChange={setPostProcessPick}
            />
          )}
        </div>
      ) : null}
      {overrideSections.map((section) => (
        <div key={section.id} className="px-2 pb-3">
          <DisclosureSection title={section.title} open={overrideOpen(section.id)} onOpenChange={(open) => setOverrideOpen(section.id, open)}>
            {section.scene!.render(overrideContext)}
          </DisclosureSection>
        </div>
      ))}
      {showSceneLayers ? (
        <div className="px-2 pb-3">
          <EntryListEditor
            title="Scene Layers"
            data-testid="scene-layers-stack"
            items={scene.settings.sceneLayers}
            addLabel="Add Layer"
            countNoun={{ one: "layer", other: "layers" }}
            onAdd={() => setSceneLayerPick("add")}
            onChange={(sceneLayers) =>
              mutate({
                ...scene,
                settings: {
                  ...scene.settings,
                  sceneLayers,
                },
              })
            }
            renderItemHeader={({ item, index }) =>
              stackAssetPicker(
                item.assetGuid,
                `scene-layer-${index}-asset`,
                `Layer ${index + 1} Asset`,
                () => setSceneLayerPick(index),
              )
            }
            renderItem={({ item, index, onChange }) => (
              <FieldGroup className="flex-row flex-wrap items-center gap-1">
                <Field
                  orientation="horizontal"
                  className="w-fit min-h-7 px-3 pointer-coarse:min-h-11"
                >
                  <FieldLabel
                    className="sr-only"
                    htmlFor={`scene-layer-${index}-enabled`}
                  >
                    Layer {index + 1} Enabled
                  </FieldLabel>
                  <Switch
                    size="sm"
                    className="pointer-coarse:after:-inset-y-[15px]"
                    id={`scene-layer-${index}-enabled`}
                    data-testid={`scene-layer-${index}-enabled`}
                    title={item.enabled !== false ? "Enabled" : "Disabled"}
                    checked={item.enabled !== false}
                    onCheckedChange={(enabled) =>
                      onChange({ ...item, enabled })
                    }
                  />
                </Field>
                <Field
                  orientation="horizontal"
                  className="w-auto min-w-0 gap-1"
                >
                  <FieldLabel htmlFor={`scene-layer-${index}-z`}>
                    Z-Order
                  </FieldLabel>
                  <NumberField
                    id={`scene-layer-${index}-z`}
                    data-testid={`scene-layer-${index}-z-order`}
                    className="h-7 w-12 px-1.5 pointer-coarse:h-11"
                    aria-label={`Layer ${index + 1} Z-Order`}
                    value={item.zOrder}
                    onChange={(zOrder) => onChange({ ...item, zOrder })}
                  />
                </Field>
              </FieldGroup>
            )}
          />
        </div>
      ) : null}
      {!visibleSettingsRows.length && !showPostProcess && overrideSections.length === 0 && !showSceneLayers
        ? noMatchingProperties
        : null}
      <AssetPicker
        open={envTexturePickOpen}
        onOpenChange={setEnvTexturePickOpen}
        assets={environmentPickerAssets}
        allowedTypes={["Texture"]}
        title="Pick Environment Texture"
        allowNone
        onPick={(environmentTextureGuid) => {
          mutate({
            ...scene,
            settings: { ...scene.settings, environmentTextureGuid },
          });
          setEnvTexturePickOpen(false);
        }}
        data-testid="scene-environment-texture-picker"
      />
      <AssetPicker
        open={effectsLutPickOpen}
        onOpenChange={setEffectsLutPickOpen}
        assets={pickerAssets}
        allowedTypes={["Texture"]}
        title="Pick LUT Texture"
        allowNone
        onPick={(lutTextureGuid) => {
          setEffectsLut(lutTextureGuid);
          setEffectsLutPickOpen(false);
        }}
        data-testid="scene-effects-lut-picker"
      />
      <AssetPicker
        open={sceneLayerPick !== null}
        onOpenChange={(open) => {
          if (!open) setSceneLayerPick(null);
        }}
        assets={pickerAssets}
        allowedTypes={["SceneLayer"]}
        title="Pick Scene Layer"
        allowNone={sceneLayerPick !== "add"}
        onPick={(assetGuid) => {
          const stack = [...scene.settings.sceneLayers];
          if (sceneLayerPick === "add") {
            if (assetGuid) {
              stack.push({
                assetGuid,
                zOrder: stack.length,
                enabled: true,
              });
            }
          } else if (typeof sceneLayerPick === "number") {
            if (!assetGuid) {
              stack.splice(sceneLayerPick, 1);
            } else {
              const current = stack[sceneLayerPick];
              stack[sceneLayerPick] = {
                assetGuid,
                zOrder: current?.zOrder ?? sceneLayerPick,
                enabled: current?.enabled !== false,
              };
            }
          }
          mutate({
            ...scene,
            settings: { ...scene.settings, sceneLayers: stack },
          });
          setSceneLayerPick(null);
        }}
        data-testid="scene-layers-picker"
      />
      <SceneActorPicker
        open={cameraPickerOpen}
        onOpenChange={setCameraPickerOpen}
        actors={sceneDefaultCameraEntries(scene)}
        title="Pick Default Camera"
        allowNone
        onPick={(defaultCameraActorId) => {
          mutate({
            ...scene,
            settings: { ...scene.settings, defaultCameraActorId },
          });
          setCameraPickerOpen(false);
        }}
        data-testid="scene-default-camera-picker"
      />
    </>
  );
}
