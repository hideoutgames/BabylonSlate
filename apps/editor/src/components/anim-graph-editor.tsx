import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ANIM_STATE_LAYOUT_GAP_X,
  animGraphToSerialized,
  animPaletteNodes,
  createDefaultAnimGraph,
  defaultAnimStatePosition,
  hydrateAnimGraphForEditor,
  parseAnimGraphDocument,
  serializedToAnimGraph,
  validateAnimGraph,
  type AnimClipKind,
  type AnimClipRef,
  type AnimGraphDocument,
  type AnimState,
  type AnimTransition,
} from "@babylonslate/anim-graph";
import {
  AssetPicker,
  NamedListEditor,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { GraphEditor } from "@babylonslate/graph-ui";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useAnimGraphEditing } from "../context/anim-graph-editing-context";

const ALWAYS_CONDITION = "__always__";

function asAnimGraph(payload: Record<string, unknown>): AnimGraphDocument {
  return parseAnimGraphDocument(payload) ?? createDefaultAnimGraph();
}

function nextAnimStatePosition(
  states: readonly Pick<AnimState, "position">[],
): { x: number; y: number } {
  if (states.length === 0) return defaultAnimStatePosition(0);
  const maxX = Math.max(...states.map((state) => state.position.x));
  const y = states[states.length - 1]?.position.y ?? defaultAnimStatePosition(0).y;
  return { x: maxX + ANIM_STATE_LAYOUT_GAP_X, y };
}

function uniqueStateId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.states.map((state) => state.id));
  let index = 1;
  while (ids.has(`state-${index}`)) index += 1;
  return `state-${index}`;
}

function uniqueStateName(doc: AnimGraphDocument, base = "State"): string {
  const names = new Set(doc.states.map((state) => state.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function addAnimState(doc: AnimGraphDocument): AnimGraphDocument {
  const id = uniqueStateId(doc);
  return {
    ...doc,
    states: [
      ...doc.states,
      {
        id,
        name: uniqueStateName(doc),
        clipId: null,
        speed: 1,
        loop: true,
        position: nextAnimStatePosition(doc.states),
      },
    ],
  };
}

function patchState(
  doc: AnimGraphDocument,
  stateId: string,
  patch: Partial<AnimState>,
): AnimGraphDocument {
  return {
    ...doc,
    states: doc.states.map((state) =>
      state.id === stateId ? { ...state, ...patch } : state,
    ),
  };
}

function patchTransition(
  doc: AnimGraphDocument,
  transitionId: string,
  patch: Partial<AnimTransition>,
): AnimGraphDocument {
  return {
    ...doc,
    transitions: doc.transitions.map((transition) =>
      transition.id === transitionId ? { ...transition, ...patch } : transition,
    ),
  };
}

function clipIdForState(stateId: string): string {
  return `clip-${stateId}`;
}

function upsertStateClip(
  doc: AnimGraphDocument,
  stateId: string,
  patch: Partial<Pick<AnimClipRef, "kind" | "assetGuid" | "clipName" | "durationMs">>,
): AnimGraphDocument {
  const state = doc.states.find((row) => row.id === stateId);
  if (!state) return doc;
  const clipId = state.clipId ?? clipIdForState(stateId);
  const existing = doc.clips.find((clip) => clip.id === clipId);
  const clip: AnimClipRef = {
    id: clipId,
    kind: patch.kind ?? existing?.kind ?? "animation",
    assetGuid: patch.assetGuid ?? existing?.assetGuid ?? "",
    clipName: patch.clipName ?? existing?.clipName ?? state.name,
    durationMs: patch.durationMs ?? existing?.durationMs ?? 1000,
  };
  const clips = existing
    ? doc.clips.map((row) => (row.id === clipId ? clip : row))
    : [...doc.clips, clip];
  return {
    ...doc,
    clips,
    states: doc.states.map((row) =>
      row.id === stateId ? { ...row, clipId } : row,
    ),
  };
}

function useAnimGraphDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const entry = openDocuments.find((item) => item.id === documentId);
  const doc = useMemo(
    () => asAnimGraph((entry?.content ?? {}) as Record<string, unknown>),
    [entry?.content],
  );
  const commit = (next: AnimGraphDocument) => {
    void applyAssetDocumentChange(
      documentId,
      next as unknown as Record<string, unknown>,
    );
  };
  return { doc, commit, assetRegistry };
}

export function AnimGraphParametersPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, commit } = useAnimGraphDocument();
  const { selectedId, setSelectedId } = useAnimGraphEditing();
  return (
    <PanelFrame>
      <div className="flex flex-col gap-4 p-3">
        <NamedListEditor
          title="Parameters"
          values={doc.parameters}
          addLabel="Add Parameter"
          addPlaceholder="Name"
          onChange={(parameters) => commit({ ...doc, parameters })}
          data-testid="anim-graph-parameters"
        />
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">States</div>
          {doc.states.map((state) => (
            <Button
              key={state.id}
              type="button"
              variant={selectedId === state.id ? "outline" : "ghost"}
              className="min-h-[var(--touch-target,44px)] w-full justify-start"
              aria-pressed={selectedId === state.id}
              data-testid={`anim-graph-state-${state.id}`}
              onClick={() => setSelectedId(state.id)}
            >
              {state.name}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] w-fit"
            data-testid="anim-graph-add-state"
            onClick={() => commit(addAnimState(doc))}
          >
            Add State
          </Button>
        </div>
      </div>
    </PanelFrame>
  );
}

export function AnimGraphGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, commit } = useAnimGraphDocument();
  const { selectedId, setSelectedId } = useAnimGraphEditing();
  const initialGraph = useMemo(
    () => hydrateAnimGraphForEditor(animGraphToSerialized(doc)),
    [doc],
  );
  const diagnostics = validateAnimGraph(doc).map((row) => ({
    nodeId: row.nodeId,
    severity: row.severity,
    message: row.message,
  }));
  return (
    <PanelFrame className="flex-1">
      <div className="flex h-full min-h-0 flex-col" data-testid="anim-graph-editor">
        <GraphEditor
          initialGraph={initialGraph}
          diagnostics={diagnostics}
          paletteNodes={animPaletteNodes()}
          focusedNodeId={selectedId ?? undefined}
          onSelectionChange={(nodeIds) => setSelectedId(nodeIds[0] ?? null)}
          onChange={(next) => {
            const updated = serializedToAnimGraph(next, doc);
            if (
              selectedId &&
              !updated.states.some((state) => state.id === selectedId)
            ) {
              setSelectedId(null);
            }
            commit(updated);
          }}
        />
      </div>
    </PanelFrame>
  );
}

export function AnimGraphDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, commit, assetRegistry } = useAnimGraphDocument();
  const { selectedId } = useAnimGraphEditing();
  const [clipPick, setClipPick] = useState(false);
  const selected = doc.states.find((state) => state.id === selectedId) ?? null;
  const clip = selected?.clipId
    ? doc.clips.find((row) => row.id === selected.clipId)
    : undefined;
  const clipKind: AnimClipKind = clip?.kind ?? "animation";
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const outgoing = selected
    ? doc.transitions.filter((row) => row.fromStateId === selected.id)
    : [];
  const stateRows: PropertyRow[] = selected
    ? [
        {
          id: "name",
          kind: "text",
          label: "Name",
          value: selected.name,
          onChange: (name) => commit(patchState(doc, selected.id, { name })),
        },
        {
          id: "entry",
          kind: "boolean",
          label: "Entry State",
          value: doc.entryStateId === selected.id,
          onChange: (value) => {
            if (value) {
              commit({ ...doc, entryStateId: selected.id });
              return;
            }
            const other = doc.states.find((state) => state.id !== selected.id);
            if (other) commit({ ...doc, entryStateId: other.id });
          },
        },
        {
          id: "clipKind",
          kind: "enum",
          label: "Clip Kind",
          value: clipKind,
          options: [
            { value: "animation", label: "Animation" },
            { value: "sprite", label: "Sprite" },
          ],
          onChange: (value) =>
            commit(
              upsertStateClip(doc, selected.id, {
                kind: value === "sprite" ? "sprite" : "animation",
              }),
            ),
        },
        {
          id: "clipAsset",
          kind: "asset",
          label: "Clip Asset",
          value: clip?.assetGuid || null,
          placeholder: "None",
          onPick: () => setClipPick(true),
          onChange: (value) =>
            commit(upsertStateClip(doc, selected.id, { assetGuid: value ?? "" })),
          ...assetRowIdentity(
            clip?.assetGuid
              ? (() => {
                  const asset = assetRegistry?.getByGuid(clip.assetGuid);
                  return asset
                    ? { name: asset.header.name, type: asset.header.type }
                    : { name: clip.assetGuid, type: clipKind === "sprite" ? "Sprite" : "Animation" };
                })()
              : undefined,
          ),
        },
        {
          id: "clipName",
          kind: "text",
          label: "Clip Name",
          value: clip?.clipName ?? "",
          onChange: (clipName) =>
            commit(upsertStateClip(doc, selected.id, { clipName })),
        },
        {
          id: "speed",
          kind: "number",
          label: "Speed",
          value: selected.speed,
          min: 0.001,
          onChange: (speed) => commit(patchState(doc, selected.id, { speed })),
        },
        {
          id: "loop",
          kind: "boolean",
          label: "Loop",
          value: selected.loop,
          onChange: (loop) => commit(patchState(doc, selected.id, { loop })),
        },
      ]
    : [];
  const transitionRows: PropertyRow[] = outgoing.flatMap((transition) => {
    const target =
      doc.states.find((state) => state.id === transition.toStateId)?.name ??
      transition.toStateId;
    return [
      {
        id: `${transition.id}-condition`,
        kind: "enum" as const,
        label: `To ${target} Condition`,
        value: transition.condition ? transition.condition : ALWAYS_CONDITION,
        options: [
          { value: ALWAYS_CONDITION, label: "Always" },
          ...doc.parameters.map((name) => ({ value: name, label: name })),
        ],
        onChange: (value) =>
          commit(
            patchTransition(doc, transition.id, {
              condition: value === ALWAYS_CONDITION ? undefined : value,
            }),
          ),
      },
      {
        id: `${transition.id}-blendSeconds`,
        kind: "number" as const,
        label: `To ${target} Blend Seconds`,
        value: transition.blendSeconds,
        min: 0,
        onChange: (blendSeconds) =>
          commit(patchTransition(doc, transition.id, { blendSeconds })),
      },
      {
        id: `${transition.id}-hasExitTime`,
        kind: "boolean" as const,
        label: `To ${target} Has Exit Time`,
        value: transition.hasExitTime,
        onChange: (hasExitTime) =>
          commit(patchTransition(doc, transition.id, { hasExitTime })),
      },
      {
        id: `${transition.id}-exitTime`,
        kind: "number" as const,
        label: `To ${target} Exit Time`,
        value: transition.exitTime,
        min: 0,
        max: 1,
        onChange: (exitTime) =>
          commit(patchTransition(doc, transition.id, { exitTime })),
      },
    ];
  });

  return (
    <PanelFrame>
      {selected ? (
        <div data-testid="anim-graph-details">
          <PropertyGrid rows={[...stateRows, ...transitionRows]} />
        </div>
      ) : (
        <p
          className="px-3 py-2 text-sm text-muted-foreground"
          data-testid="anim-graph-details-empty"
        >
          Select a State
        </p>
      )}
      <AssetPicker
        open={clipPick}
        onOpenChange={setClipPick}
        assets={assets}
        allowedTypes={clipKind === "sprite" ? ["Sprite"] : ["Animation"]}
        title={clipKind === "sprite" ? "Pick Sprite" : "Pick Animation"}
        allowNone
        onPick={(guid) => {
          if (selected) {
            commit(upsertStateClip(doc, selected.id, { assetGuid: guid ?? "" }));
          }
          setClipPick(false);
        }}
        data-testid="anim-graph-clip-picker"
      />
    </PanelFrame>
  );
}
