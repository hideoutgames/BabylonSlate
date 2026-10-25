import { useMemo, useState } from "react";
import { normalizeModelPayload } from "@haptic/assets";
import {
  identitySerializedTransform,
  isFocusTargetClass,
  normalizeRenderTargetCaptureProperties,
  parseOverlayPanelProperties,
  parseText2DAppearProperties,
  parseText2DProperties,
  parseText3DProperties,
  parseUIControl2DProperties,
  type CollisionPreset,
  type SerializedComponent,
  type SerializedTransform,
  type ViewportMode,
} from "@haptic/core";
import {
  AssetPicker,
  MultilineTextField,
  NamedListEditor,
  PropertyGrid,
  TypeVisualIcon,
  humanizePropertyLabel,
  resolveTypeVisual,
  walkAncestry,
  type ClassPickerEntry,
} from "@haptic/editor-kit";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { useRegistryState } from "../context/document-context";
import { useAreaEmissionStatus } from "../lib/use-area-emission-status";
import { saveGameVariableNames } from "../lib/save-game-property-rows";
import { MODEL_MATERIALS_PICKER_ENTRY } from "../lib/mesh-material-properties";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import { spatialTransformPropertyRows } from "../lib/transform-property-rows";
import {
  componentPropertyRows,
  type AssetPickRequest,
  type ComponentPropertyUpdate,
} from "../lib/component-property-rows";
import { materialDomainsFromAssets } from "../lib/content-browser-helpers";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import { RagdollBoneNamesEditor } from "../components/ragdoll-bone-names-editor";
import { ClassCaptureActorsField } from "../components/class-capture-actors-field";
import { RichTextAppearModesField } from "../components/rich-text-appear-modes-field";
import { NineSlicePreview } from "../components/nine-slice-preview";

const CLASS_KINDS = ["graph"] as const;
const MODEL_KINDS = ["model"] as const;

export function PrefabComponentDetails({
  actorClassId,
  component,
  components,
  sceneLayerClasses,
  sortingLayers,
  collisionLayers,
  collisionPresets,
  physicsWorld,
  viewportMode,
  pickerAssets,
  parentOf,
  assetLabel,
  assetType,
  fontHasFacetype,
  fontHasMsdfJson,
  fontHasMsdfPng,
  onUpdate,
  onUpdateTransform,
}: {
  actorClassId: string;
  component: SerializedComponent;
  components: readonly SerializedComponent[];
  sceneLayerClasses: ClassPickerEntry[];
  sortingLayers: readonly string[];
  collisionLayers: readonly string[];
  collisionPresets?: readonly CollisionPreset[];
  physicsWorld: "3d" | "2d";
  viewportMode: ViewportMode;
  pickerAssets: Array<{
    guid: string;
    name: string;
    type: string;
    path?: string;
  }>;
  /** Class ancestry from the Inspector, shared until the registry changes. */
  parentOf: (id: string) => string | null;
  assetLabel: (guid: string | null | undefined) => string | undefined;
  assetType: (guid: string | null | undefined) => string | undefined;
  fontHasFacetype?: (guid: string | null | undefined) => boolean;
  fontHasMsdfJson?: (guid: string | null | undefined) => boolean;
  fontHasMsdfPng?: (guid: string | null | undefined) => boolean;
  onUpdate: ComponentPropertyUpdate;
  onUpdateTransform: (transform: SerializedTransform) => void;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const areaEmissionStatus = useAreaEmissionStatus();
  // Open Class and Model tabs override saved content in these rows.
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const modelDocuments = useOpenDocumentsOfKinds(MODEL_KINDS);
  // Kept across renders, so a gizmo drag does not walk every Class again.
  const classGraphs = useMemo(() => {
    void registryEpoch;
    return collectClassGraphsForPalette({ assets: assetRegistry?.list() ?? [], openDocuments: classDocuments, classIdForPath: classIdForGraphPath });
  }, [assetRegistry, classDocuments, registryEpoch]);
  const [assetPick, setAssetPick] = useState<AssetPickRequest | null>(null);
  // An open Material tab's unsaved domain wins over its saved header.
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const materialDomains = useMemo(() => {
    void registryEpoch;
    return materialDomainsFromAssets(assetRegistry?.list() ?? [], materialDocuments);
  }, [assetRegistry, materialDocuments, registryEpoch]);
  return (
    <div
      className="flex flex-col gap-3 p-3"
      data-testid="inspector-prefab-component"
    >
      {component.classId !== "2DAnchorComponent" && component.classId !== "MovementComponent" && component.classId !== "DeformerComponent" && component.classId !== "SaveGameComponent" && <PropertyGrid
        title="Transform"
        rows={spatialTransformPropertyRows(
          component.id,
          viewportMode,
          component.transform ?? identitySerializedTransform(),
          onUpdateTransform,
        )}
        data-testid="prefab-component-transform-grid"
      />}
      <div className="overflow-hidden rounded-lg border border-border/60 bg-sidebar">
        <div className="flex items-center gap-2 border-b border-border/60 bg-panel-header px-2 py-1">
          <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
            <TypeVisualIcon
              visual={resolveTypeVisual({
                classId: component.classId,
                ancestry: walkAncestry(component.classId, parentOf),
              })}
              data-testid={`inspector-prefab-type-icon-${component.id}`}
            />
            {component.classId}
          </span>
        </div>
        {component.classId === "2DRichTextComponent" ? (
          <RichTextAppearModesField
            value={parseText2DAppearProperties(component.properties).appearModes}
            onChange={(appearModes) => onUpdate("appearModes", appearModes)}
            data-testid={`rich-text-appear-modes-${component.id}`}
          />
        ) : null}
        <PropertyGrid
          rows={componentPropertyRows(PREFAB_ROOT_ID, component, onUpdate, {
            sortingLayers,
            collisionLayers,
            collisionPresets,
            assetLabel,
            assetType,
            modelMaterialSlots: (guid) => normalizeModelPayload(
              modelDocuments.find((doc) => doc.ref.path === assetRegistry?.getByGuid?.(guid)?.path)?.content
                ?? assetRegistry?.getByGuid?.(guid)?.header.payload ?? {},
            ).materialSlots,
            fontHasFacetype,
            fontHasMsdfJson,
            fontHasMsdfPng,
            physicsWorld,
            onPickAsset: setAssetPick,
            areaEmissionStatus,
            actorComponents: (targetId) => targetId === PREFAB_ROOT_ID ? components : [],
            actorVariableNames: () => saveGameVariableNames(actorClassId, classGraphs, parentOf),
            componentVariableNames: (classId) => saveGameVariableNames(classId, classGraphs, parentOf),
            sceneLayerClasses: sceneLayerClasses,
            focusTargets: components.filter((entry) => isFocusTargetClass(entry.classId)).map((entry, index) => ({ value: entry.id, label: `${humanizePropertyLabel(entry.classId.replace(/Component$/, ""))} ${index + 1}` })),
          })}
        />
        {component.classId === "2DDropdownComponent" ? <NamedListEditor title="Options" values={parseUIControl2DProperties(component.classId, component.properties).options} addLabel="Add Option" onChange={(options) => onUpdate("options", options)} /> : null}
        {component.classId === "2DPanelComponent" ? (
          <NineSlicePreview
            {...parseOverlayPanelProperties(component.properties)}
          />
        ) : null}
        {component.classId === "RagdollComponent" ? (
          <RagdollBoneNamesEditor
            boneNames={component.properties.boneNames as string[] | undefined}
            onChange={(boneNames) => onUpdate("boneNames", boneNames)}
            data-testid={`ragdoll-bone-names-${component.id}`}
          />
        ) : null}
        {component.classId === "RenderTargetCaptureComponent" && component.properties.captureOnlyActors === true ? (
          <ClassCaptureActorsField
            actorIds={normalizeRenderTargetCaptureProperties(component.properties).actorIds}
            onChange={(actorIds) => onUpdate("actorIds", actorIds)} />
        ) : null}
      </div>
      {component.classId === "Text3DComponent" ? (
        <Field>
          <FieldLabel htmlFor={`text3d-text-${component.id}`}>Text</FieldLabel>
          <MultilineTextField
            id={`text3d-text-${component.id}`}
            title="Text"
            disabled={component.properties.editorOnly === true}
            value={parseText3DProperties(component.properties).text}
            onChange={(value) => onUpdate("text", value)}
            data-testid={`text3d-text-${component.id}`}
          />
        </Field>
      ) : null}
      {component.classId === "2DTextComponent" ||
      component.classId === "2DRichTextComponent" ? (
        <Field>
          <FieldLabel htmlFor={`text2d-text-${component.id}`}>Text</FieldLabel>
          <MultilineTextField
            id={`text2d-text-${component.id}`}
            title="Text"
            markup={component.classId === "2DRichTextComponent"}
            value={
              parseText2DProperties(component.properties, {
                rich: component.classId === "2DRichTextComponent",
              }).text
            }
            onChange={(value) => onUpdate("text", value)}
            data-testid={`text2d-text-${component.id}`}
          />
        </Field>
      ) : null}
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={assetPick?.materialDomain === "text" ? pickerAssets.filter((asset) => materialDomains[asset.guid] === "text") : assetPick?.property === "materialGuid" && component.classId === "MeshComponent" && component.properties.assetGuid
          ? [MODEL_MATERIALS_PICKER_ENTRY, ...pickerAssets]
          : pickerAssets}
        allowedTypes={assetPick?.allowedTypes}
        title={assetPick?.title ?? "Pick Asset"}
        allowNone
        onPick={(guid) => {
          if (!assetPick) return;
          if (guid && assetPick.materialDomain === "text" && materialDomains[guid] !== "text") return;
          // A Font without an MSDF pair stores Bitmap in the same edit as the Font.
          const bitmapFont =
            assetPick.property === "fontAssetGuid" &&
            (component.classId === "2DTextComponent" ||
              component.classId === "2DRichTextComponent") &&
            !(guid && fontHasMsdfJson?.(guid) && fontHasMsdfPng?.(guid));
          onUpdate(assetPick.property, guid, bitmapFont ? { renderer: "bitmap" } : undefined);
          setAssetPick(null);
        }}
        data-testid="inspector-prefab-asset-picker"
      />
    </div>
  );
}
