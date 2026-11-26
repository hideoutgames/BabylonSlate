import { memo, type Dispatch, type SetStateAction } from "react";
import {
  InlineRenameInput,
  NamedListEditor,
  PropertyGrid,
  TypeVisualIcon,
  resolveTypeVisual,
  useDoubleTap,
  walkAncestry,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  normalizeRenderTargetCaptureProperties,
  parseOverlayPanelProperties,
  parseText2DAppearProperties,
  parseText2DProperties,
  parseText3DProperties,
  parseUIControl2DProperties,
  patchComponentProperties,
  type SerializedActor,
  type SerializedComponent,
} from "@haptic/core";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { ComponentTextField } from "../components/component-text-field";
import { IconActionButton } from "../components/icon-action-button";
import { NineSlicePreview } from "../components/nine-slice-preview";
import { RagdollBoneNamesEditor } from "../components/ragdoll-bone-names-editor";
import { RenderTargetCaptureActorsField } from "../components/render-target-capture-actors-field";
import { ProjectRichTextAppearModesField } from "../components/rich-text-appear-modes-field";
import type { SceneShapeEditTarget } from "../context/scene-editing-context";
import type { NavBakeContextValue } from "../context/nav-bake-context";
import type { classParentLookup } from "../lib/content-browser-helpers";
import { renamedComponentName, type prefabComponentLabelParts } from "./add-component-catalog";

/** The actor with one component's `text` property set. */
function patchActorComponentText(actor: SerializedActor, componentId: string, text: string): SerializedActor {
  return {
    ...actor,
    components: actor.components.map((candidate) => candidate.id === componentId
      ? { ...candidate, properties: patchComponentProperties(candidate.properties, "text", text) }
      : candidate),
  };
}

/** Component card name; double-click or double-tap starts an inline rename. */
function ComponentCardName({ title, onRename }: { title: string; onRename: () => void }) {
  const onTap = useDoubleTap(onRename);
  return (
    <span
      className="truncate"
      title={`${title} · Double-click to rename`}
      data-component-name=""
      onDoubleClick={(event) => {
        event.stopPropagation();
        onRename();
      }}
      onPointerUp={onTap}
    >
      {title}
    </span>
  );
}

/**
 * One component card's rows and state, built by the Inspector for the selected
 * actor. In a multi-selection the card stands for one component class every
 * selected actor has: `component` is the primary actor's, and the rows edit each.
 */
export interface SceneComponentDetail {
  component: SerializedComponent;
  template: SerializedComponent | undefined;
  index: number;
  title: string;
  nameParts: ReturnType<typeof prefabComponentLabelParts>;
  rows: PropertyRow[];
  colliderRows: PropertyRow[];
  /** A Particle component's **Parameters** override rows; empty for other classes. */
  parameterRows: PropertyRow[];
  showExtras: boolean;
  expanded: boolean;
}

export interface SceneComponentCardProps extends SceneComponentDetail {
  actorId: string;
  actorLocked: boolean;
  actorComponents: readonly SerializedComponent[];
  /** Scene actors for `RenderTargetCaptureComponent`'s actor picker; omitted for other classes so actor moves stay memoized. */
  captureActors?: readonly SerializedActor[];
  parentOf: ReturnType<typeof classParentLookup>;
  /** Changes the primary actor; the reorder and class extras use it, so they show only for one actor. */
  updateActor: (update: (actor: SerializedActor) => SerializedActor) => void;
  /** Changes the card's component on every selected actor, as one edit. */
  editComponent: (update: (component: SerializedComponent) => SerializedComponent) => void;
  /** Removes the card's component from every selected actor, as one edit. */
  removeComponent: () => void;
  /** True only while this specific card's inline rename input is active. */
  renaming: boolean;
  setRenamingComponentKey: (key: string | null) => void;
  /** Updates this render's collapse set: the filter's while a filter is typed. */
  setCollapsedKeys: Dispatch<SetStateAction<Set<string>>>;
  shapeEditable: boolean;
  /** This card's component is the actor's active shape edit target. */
  shapeEditing: boolean;
  multiSelection: boolean;
  setShapeEditTarget: (target: SceneShapeEditTarget | null) => void;
  navBake: NavBakeContextValue | null;
}

/**
 * One component card in the actor Inspector: header with rename, reorder and
 * remove, the shape edit toggle, then the rows with each class's extra editor
 * in place; a multi-selection has no reorder. Memoized so actor transform drags
 * and unrelated scene edits skip re-rendering component cards. A new
 * class-specific extra also needs its search words in the Inspector's
 * `extraLabels`.
 */
export const SceneComponentCard = memo(function SceneComponentCard(props: SceneComponentCardProps) {
  const {
    component,
    template,
    index,
    title,
    nameParts,
    rows,
    colliderRows,
    parameterRows,
    showExtras,
    expanded,
    actorId,
    actorLocked,
    actorComponents,
    captureActors,
    parentOf,
    updateActor,
    editComponent,
    removeComponent,
    renaming,
    setRenamingComponentKey,
    setCollapsedKeys,
    shapeEditable,
    shapeEditing,
    multiSelection,
    setShapeEditTarget,
    navBake,
  } = props;
  return (
    <div
      className="mx-2 overflow-hidden rounded-lg border border-border/60 bg-sidebar"
      data-testid={`component-card-${component.id}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-panel-header px-2 py-1">
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TypeVisualIcon
              visual={resolveTypeVisual({
                classId: component.classId,
                ancestry: walkAncestry(component.classId, parentOf),
              })}
            />
            <InlineRenameInput
              value={nameParts.name}
              aria-label={`Rename ${title}`}
              data-testid={`component-rename-${component.id}`}
              onDone={(name) => {
                setRenamingComponentKey(null);
                if (name === null) return;
                editComponent((candidate) => {
                  const next = { ...candidate };
                  const renamed = renamedComponentName(candidate.classId, name);
                  if (renamed === undefined) delete next.name;
                  else next.name = renamed;
                  return next;
                });
              }}
            />
            {nameParts.detail ? (
              <span className="shrink-0 text-[13px] text-muted-foreground">{nameParts.detail}</span>
            ) : null}
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start px-0"
            aria-label={title}
            aria-expanded={expanded}
            aria-controls={`component-details-${actorId}-${component.id}`}
            onClick={() => {
              setCollapsedKeys((current) => {
                const next = new Set(current);
                const key = `${actorId}:${component.id}`;
                if (expanded) next.add(key);
                else next.delete(key);
                return next;
              });
            }}
          >
            <ChevronDownIcon
              className={expanded ? undefined : "-rotate-90"}
            />
            <TypeVisualIcon
              visual={resolveTypeVisual({
                classId: component.classId,
                ancestry: walkAncestry(
                  component.classId,
                  parentOf,
                ),
              })}
              data-testid={`component-type-icon-${component.id}`}
            />
            <ComponentCardName
              title={title}
              onRename={() => setRenamingComponentKey(`${actorId}:${component.id}`)}
            />
          </Button>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {multiSelection ? null : (
            <IconActionButton
              label={`Move ${title} Up`}
              disabled={index === 0}
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
              <ChevronUpIcon />
            </IconActionButton>
          )}
          <IconActionButton
            label={`Remove ${title}`}
            onClick={removeComponent}
            data-testid={`component-remove-${component.id}`}
          >
            <Trash2Icon />
          </IconActionButton>
        </div>
      </div>
      {shapeEditable ? (
        <div className="flex px-2 py-1">
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-11"
            aria-label={`Edit ${title} In Viewport`}
            aria-pressed={shapeEditing}
            disabled={actorLocked || multiSelection}
            onClick={() => setShapeEditTarget({ actorId, componentId: component.id })}
            data-testid={`component-shape-edit-${component.id}`}
          >
            {shapeEditing ? "Editing In Viewport" : "Edit In Viewport"}
          </Button>
        </div>
      ) : null}
      {expanded ? (
        <div id={`component-details-${actorId}-${component.id}`}>
          {showExtras && component.classId === "2DDropdownComponent" ? <NamedListEditor title="Options" values={parseUIControl2DProperties(component.classId, component.properties).options} addLabel="Add Option" onChange={(options) => updateActor(entry => ({ ...entry, components: entry.components.map(candidate => candidate.id === component.id ? { ...candidate, properties: { ...candidate.properties, options } } : candidate) }))} /> : null}
          {showExtras && component.classId === "2DRichTextComponent" ? (
            <ProjectRichTextAppearModesField
              value={parseText2DAppearProperties(component.properties).appearModes}
              defaultValue={parseText2DAppearProperties(template?.properties ?? {}).appearModes}
              onChange={(appearModes) => updateActor((entry) => ({
                ...entry,
                components: entry.components.map((candidate) => candidate.id === component.id
                  ? { ...candidate, properties: { ...candidate.properties, appearModes } }
                  : candidate),
              }))}
              data-testid={`rich-text-appear-modes-${component.id}`}
            />
          ) : null}
          {rows.length ? <PropertyGrid rows={rows} /> : null}
          {showExtras && component.classId === "RenderTargetCaptureComponent" && component.properties.captureOnlyActors === true ? (
            <RenderTargetCaptureActorsField actors={captureActors ?? []} actorIds={normalizeRenderTargetCaptureProperties(component.properties).actorIds}
              onChange={(actorIds) => updateActor((entry) => ({ ...entry, components: entry.components.map((candidate) => candidate.id === component.id ? { ...candidate, properties: { ...candidate.properties, actorIds } } : candidate) }))} />
          ) : null}
          {showExtras && component.classId === "RagdollComponent" ? (
            <RagdollBoneNamesEditor
              boneNames={component.properties.boneNames as string[] | undefined}
              components={actorComponents}
              onChange={(boneNames) => updateActor((entry) => ({
                ...entry,
                components: entry.components.map((candidate) => candidate.id === component.id
                  ? { ...candidate, properties: { ...candidate.properties, boneNames } }
                  : candidate),
              }))}
              data-testid={`ragdoll-bone-names-${component.id}`}
            />
          ) : null}
          {showExtras && component.classId === "2DPanelComponent" ? (
            <NineSlicePreview
              {...parseOverlayPanelProperties(component.properties)}
            />
          ) : null}
          {showExtras && component.classId === "Text3DComponent" ? (
            <div className="p-2">
              <ComponentTextField
                key={`${actorId}:${component.id}`}
                fieldKey={`component:${actorId}:${component.id}:text`}
                id={`text3d-text-${component.id}`}
                disabled={component.properties.editorOnly === true && actorComponents.some((entry) => entry.id === component.parentId && entry.classId === "SceneStreamingComponent")}
                value={parseText3DProperties(component.properties).text}
                onChange={(value) => updateActor((entry) => patchActorComponentText(entry, component.id, value))}
              />
            </div>
          ) : null}
          {showExtras &&
          (component.classId === "2DTextComponent" ||
            component.classId === "2DRichTextComponent") ? (
            <div className="p-2">
              <ComponentTextField
                key={`${actorId}:${component.id}`}
                fieldKey={`component:${actorId}:${component.id}:text`}
                id={`text2d-text-${component.id}`}
                markup={component.classId === "2DRichTextComponent"}
                value={parseText2DProperties(component.properties, {
                  rich: component.classId === "2DRichTextComponent",
                }).text}
                onChange={(value) => updateActor((entry) => patchActorComponentText(entry, component.id, value))}
              />
            </div>
          ) : null}
          {parameterRows.length ? (
            <PropertyGrid
              title="Parameters"
              rows={parameterRows}
              data-testid={`particle-parameters-grid-${component.id}`}
            />
          ) : null}
          {colliderRows.length ? (
            <PropertyGrid
              title="Transform"
              rows={colliderRows}
              data-testid={`${component.classId === "ColliderComponent" ? "collider" : "component"}-transform-grid-${component.id}`}
            />
          ) : null}
          {showExtras && component.classId === "NavMeshComponent" ? (
            <div className="p-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                data-testid={`navmesh-bake-${component.id}`}
                disabled={navBake?.baking}
                onClick={() => {
                  void navBake?.startBake(component.properties);
                }}
              >
                Bake NavMesh
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
