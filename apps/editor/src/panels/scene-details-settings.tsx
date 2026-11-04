import type { Dispatch, ReactNode, SetStateAction } from "react";
import { RENDERING_SETTINGS_SECTIONS, type RenderingSceneContext } from "../components/rendering-settings-sections";
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
  normalizeRenderEffectsOverrides,
  normalizeScenePostProcessStack,
  resolveRenderEffectsSettings,
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
  effectsLutPickOpen: boolean;
  setEffectsLutPickOpen: Dispatch<SetStateAction<boolean>>;
  cameraPickerOpen: boolean;
  setCameraPickerOpen: Dispatch<SetStateAction<boolean>>;
  postProcessPick: "add" | { id: string } | null;
  setPostProcessPick: Dispatch<SetStateAction<"add" | { id: string } | null>>;
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
  const showPostProcess = matches("Post-Process Passes Material Entry ID Enabled Scalable Resolution");
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
          <EntryListEditor
            title="Post-Process Passes"
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
