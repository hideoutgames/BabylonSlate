import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ShadowSettingsFields, SHADOW_SETTINGS_SEARCH_TEXT } from "../components/shadow-settings-fields";
import { EnvironmentLightingFields, ENVIRONMENT_LIGHTING_SEARCH_TEXT } from "../components/environment-lighting-fields";
import { CelShadingFields } from "../components/cel-shading-fields";
import {
  AssetPicker,
  AssetPickerControl,
  EntryListEditor,
  DisclosureSection,
  NumberField,
  PropertyGrid,
  SceneComponentPicker,
  assetRowIdentity,
  selectedPickerIdentity,
  type AssetPickerEntry,
  type ClassPickerEntry,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  normalizeCelShadingSettings,
  normalizeScenePostProcessStack,
  newGuid,
  type ProjectDocument,
  type SerializedScene,
} from "@haptic/core";
import { HashIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@haptic/ui/components/dialog";
import { Switch } from "@haptic/ui/components/switch";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { IconActionButton } from "../components/icon-action-button";
import { sceneComponentEntries } from "../lib/scene-component-entries";
import { ENVIRONMENT_ROW_IDS, sceneDetailsSettingsRows } from "./scene-details-settings-rows";

function PostProcessEntryId({ id, index }: { id: string; index: number }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <IconActionButton
            label={`Pass ${index + 1} Entry ID`}
            className="shrink-0 pointer-coarse:size-11"
          />
        }
      >
        <HashIcon />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pass {index + 1} Entry ID</DialogTitle>
          <DialogDescription>
            Copy this ID to target this pass with Get Post Process Entry.
          </DialogDescription>
        </DialogHeader>
        <PropertyGrid density="compact" rows={[{
          kind: "text",
          id: `scene-post-process-${id}-entry-id`,
          label: "Entry ID",
          value: id,
          readOnly: true,
          onChange: () => {},
        }]} />
      </DialogContent>
    </Dialog>
  );
}

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
  cameraPickerOpen: boolean;
  setCameraPickerOpen: Dispatch<SetStateAction<boolean>>;
  postProcessPick: "add" | { id: string } | null;
  setPostProcessPick: Dispatch<SetStateAction<"add" | { id: string } | null>>;
  sceneLayerPick: "add" | number | null;
  setSceneLayerPick: Dispatch<SetStateAction<"add" | number | null>>;
}

/**
 * The Inspector with no actor selected: Scene Settings, Post Processing,
 * Environment Lighting, Shadows, CEL Shading and Scene Layers, then their
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
    cameraPickerOpen,
    setCameraPickerOpen,
    postProcessPick,
    setPostProcessPick,
    sceneLayerPick,
    setSceneLayerPick,
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
  const celEnabled = !overlay && projectDocument?.settings.render.mode === "cel";
  const showPostProcess = matches("Post Processing Material Entry ID Enabled Scalable Resolution");
  const showShadows = !overlay && matches(SHADOW_SETTINGS_SEARCH_TEXT);
  const showEnvironment = !overlay && matches(ENVIRONMENT_LIGHTING_SEARCH_TEXT);
  const showCel = celEnabled && matches("Post Processing CEL Shading Shadow Bands Threshold Strength Specular Light Color Influence Mixing Strongest Additive Blend Outlines Outline Color Width Distance Fade Start End");
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
          <EntryListEditor
            title="Post Processing"
            data-testid="scene-post-process-stack"
            items={postProcessEntries}
            getItemKey={(item) => item.id}
            addLabel="Add Pass"
            countNoun={{ one: "pass", other: "passes" }}
            onAdd={() => setPostProcessPick("add")}
            onChange={(postProcessStack) =>
              mutate({
                ...scene,
                settings: {
                  ...scene.settings,
                  postProcessStack: normalizeScenePostProcessStack(postProcessStack),
                },
              })
            }
            renderItemHeader={({ item, index }) => (
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  {stackAssetPicker(
                    item.materialGuid,
                    `scene-post-process-${index}-material`,
                    `Pass ${index + 1} Material`,
                    () => setPostProcessPick({ id: item.id }),
                  )}
                </div>
                <PostProcessEntryId id={item.id} index={index} />
              </div>
            )}
            renderItem={({ item, index, onChange }) => (
              <div className="flex items-center justify-between gap-2 px-2 pointer-coarse:flex-wrap">
              <Field
                orientation="horizontal"
                className="w-fit min-h-7 gap-1 pointer-coarse:min-h-11"
              >
                <FieldLabel htmlFor={`scene-post-process-${index}-enabled`}>
                  Enabled
                </FieldLabel>
                <Switch
                  size="sm"
                  className="pointer-coarse:after:-inset-y-[15px]"
                  id={`scene-post-process-${index}-enabled`}
                  data-testid={`scene-post-process-${index}-enabled`}
                  aria-label={`Pass ${index + 1} Enabled`}
                  checked={item.enabled !== false}
                  onCheckedChange={(enabled) =>
                    onChange({ ...item, enabled })
                  }
                />
              </Field>
              <Field orientation="horizontal" className="w-fit min-h-7 gap-1 pointer-coarse:min-h-11">
                <FieldLabel htmlFor={`scene-post-process-${index}-scalable`} title="Allow quality settings to scale this pass resolution">Scalable</FieldLabel>
                <Switch size="sm" className="pointer-coarse:after:-inset-y-[15px]" id={`scene-post-process-${index}-scalable`} aria-label={`Pass ${index + 1} Scalable Resolution`} checked={item.scalable === true} onCheckedChange={(scalable) => onChange({ ...item, scalable })} />
              </Field>
              </div>
            )}
          />
        </div>
      ) : null}
      {showEnvironment ? (
        <div className="px-2 pb-3">
          <DisclosureSection title="Environment Lighting" open={overrideOpen("environment")} onOpenChange={(open) => setOverrideOpen("environment", open)}>
            <EnvironmentLightingFields hideTitle cel={celEnabled} project={projectDocument?.settings.render.environmentLighting} overrides={scene.settings.environmentLighting ?? {}} onChange={(environmentLighting) => mutate({ ...scene, settings: { ...scene.settings, environmentLighting } })}>
              <PropertyGrid rows={settingsRows.filter((row) => ENVIRONMENT_ROW_IDS.has(row.id))} />
            </EnvironmentLightingFields>
          </DisclosureSection>
        </div>
      ) : null}
      {showShadows ? (
        <div className="px-2 pb-3">
          <DisclosureSection title="Shadows" open={overrideOpen("shadows")} onOpenChange={(open) => setOverrideOpen("shadows", open)}>
            <ShadowSettingsFields hideTitle project={projectDocument?.settings.render.shadows} overrides={scene.settings.shadowOverrides ?? {}} onChange={(shadowOverrides) => mutate({ ...scene, settings: { ...scene.settings, shadowOverrides } })} />
          </DisclosureSection>
        </div>
      ) : null}
      {showCel ? (
        <div className="px-2 pb-3">
          <DisclosureSection title="CEL Shading" open={overrideOpen("cel")} onOpenChange={(open) => setOverrideOpen("cel", open)}>
          <CelShadingFields
            hideTitle
            project={normalizeCelShadingSettings(projectDocument?.settings.render.cel)}
            overrides={scene.settings.celShading ?? {}}
            onChange={(celShading) => mutate({ ...scene, settings: { ...scene.settings, celShading } })}
          />
          </DisclosureSection>
        </div>
      ) : null}
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
      {!visibleSettingsRows.length && !showPostProcess && !showShadows && !showEnvironment && !showCel && !showSceneLayers
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
      <AssetPicker
        open={postProcessPick !== null}
        onOpenChange={(open) => {
          if (!open) setPostProcessPick(null);
        }}
        assets={postProcessPickerAssets}
        allowedTypes={["Material", "MaterialInstance"]}
        createTypes={["Material"]}
        createOptions={{ materialDomain: "postProcess" }}
        title="Pick Post-Process Material"
        allowNone={postProcessPick !== "add"}
        onPick={(materialGuid) => {
          const stack = [...postProcessEntries];
          if (postProcessPick === "add") {
            if (materialGuid) {
              stack.push({ id: newGuid(), materialGuid, enabled: true });
            }
          } else if (postProcessPick) {
            const index = stack.findIndex((entry) => entry.id === postProcessPick.id);
            if (index < 0) {
              setPostProcessPick(null);
              return;
            }
            if (!materialGuid) {
              stack.splice(index, 1);
            } else {
              const current = stack[index]!;
              stack[index] = {
                ...current,
                materialGuid,
                enabled: current?.enabled !== false,
              };
            }
          }
          mutate({
            ...scene,
            settings: { ...scene.settings, postProcessStack: normalizeScenePostProcessStack(stack) },
          });
          setPostProcessPick(null);
        }}
        data-testid="scene-post-process-picker"
      />
      <SceneComponentPicker
        open={cameraPickerOpen}
        onOpenChange={setCameraPickerOpen}
        components={sceneComponentEntries(scene, ["CameraComponent"])}
        allowedClassIds={["CameraComponent"]}
        title="Pick Default Camera"
        allowNone
        onPick={(ref) => {
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              mainCameraActorId: ref?.actorId ?? null,
              mainCameraComponentId: ref?.componentId ?? null,
            },
          });
          setCameraPickerOpen(false);
        }}
        data-testid="scene-default-camera-picker"
      />
    </>
  );
}
