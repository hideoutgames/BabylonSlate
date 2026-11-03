import type { IDockviewPanelProps } from "dockview-react";
import {
  GLOBAL_PARAMETER_NAME_MAX,
  GLOBAL_PARAMETER_TYPES,
  GLOBAL_PARAMETER_TYPE_LABELS,
  globalParameterStartValue,
  normalizeGlobalParameterCollection,
  normalizeGlobalParameterName,
  resizeGlobalParameterValue,
  uniqueGlobalParameterName,
  type GlobalParameter,
  type GlobalParameterType,
} from "@haptic/core";
import { EntryListEditor, PanelFrame, PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { newParticleParameterId, particleParameterValueRow } from "../lib/particle-parameter-rows";

/**
 * A Global Parameter Collection's parameters: add, rename, retype, reorder and delete them and
 * edit their defaults. A taken name gets the first free `_N` suffix; retyping resizes the
 * default, and a new Color starts opaque. Every Material, Particle Graph and Class graph that reads a parameter follows it.
 */
export function GlobalParameterListEditor({
  parameters,
  onChange,
}: {
  parameters: readonly GlobalParameter[];
  /** `mergeKey` groups one gesture's edits into one undo entry. */
  onChange: (next: GlobalParameter[], mergeKey?: string) => void;
}) {
  const rows = (parameter: GlobalParameter, update: (value: GlobalParameter, mergeKey?: string) => void): PropertyRow[] => [
    {
      id: `global-parameter-${parameter.id}-name`,
      kind: "text",
      label: "Name",
      value: parameter.name,
      description: `Class graphs set it by this name. Unique in the collection, up to ${GLOBAL_PARAMETER_NAME_MAX} characters; a taken name gets _1, _2 and so on.`,
      onChange: () => undefined,
      onCommit: (text) => {
        const name = normalizeGlobalParameterName(text);
        if (name && name !== parameter.name) update({ ...parameter, name: uniqueGlobalParameterName(parameters, name, parameter.id) });
      },
    },
    {
      id: `global-parameter-${parameter.id}-type`,
      kind: "enum",
      label: "Type",
      value: parameter.type,
      options: GLOBAL_PARAMETER_TYPES.map((type) => ({ value: type, label: GLOBAL_PARAMETER_TYPE_LABELS[type] })),
      onChange: (next) => {
        const type = next as GlobalParameterType;
        const defaultValue = resizeGlobalParameterValue(parameter.defaultValue, type);
        // A value that becomes a Color starts opaque.
        if (type === "color" && parameter.type !== "color") defaultValue[3] = 1;
        update({ ...parameter, type, defaultValue });
      },
    },
    particleParameterValueRow({
      id: `global-parameter-${parameter.id}-default`,
      label: "Default",
      type: parameter.type,
      value: parameter.defaultValue,
      onChange: (defaultValue) => update({ ...parameter, defaultValue }, `global-parameter:${parameter.id}:default`),
    }),
  ];
  return (
    <EntryListEditor<GlobalParameter>
      items={parameters}
      getItemKey={(parameter) => parameter.id}
      onChange={(next) => onChange(next)}
      onCreate={(): GlobalParameter => ({
        id: newParticleParameterId(),
        name: uniqueGlobalParameterName(parameters),
        type: "float",
        defaultValue: globalParameterStartValue("float"),
      })}
      addLabel="Add Parameter"
      countNoun={{ one: "parameter", other: "parameters" }}
      renderItem={({ item }) => (
        <PropertyGrid
          density="compact"
          rows={rows(item, (value, mergeKey) =>
            onChange(parameters.map((entry) => (entry.id === value.id ? value : entry)), mergeKey))}
        />
      )}
      data-testid="global-parameter-list"
    />
  );
}

/** Global Parameter Collection **Parameters** window. */
export function GlobalParameterCollectionPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const collection = normalizeGlobalParameterCollection(doc?.content);
  return (
    <PanelFrame data-testid="global-parameter-collection-panel">
      <div className="flex flex-col pb-2">
        <GlobalParameterListEditor
          parameters={collection.parameters}
          onChange={(parameters, mergeKey) => {
            void applyAssetDocumentChange(
              documentId,
              normalizeGlobalParameterCollection({ ...collection, parameters }) as unknown as Record<string, unknown>,
              mergeKey,
            );
          }}
        />
      </div>
    </PanelFrame>
  );
}
