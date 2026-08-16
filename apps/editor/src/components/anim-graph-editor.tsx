import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ANIM_STATE_LAYOUT_GAP_X,
  animGraphMembersFromVariables,
  animGraphToSerialized,
  animPaletteNodes,
  createDefaultAnimGraph,
  defaultAnimStatePosition,
  defaultAnimVariableValue,
  hydrateAnimGraphForEditor,
  parseAnimGraphDocument,
  serializedToAnimGraph,
  validateAnimGraph,
  type AnimClipKind,
  type AnimClipRef,
  type AnimGraphDocument,
  type AnimGraphVariable,
  type AnimState,
  type AnimTransition,
  type AnimVariableTypeId,
} from "@babylonslate/anim-graph";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  ToolbarStrip,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  GraphEditor,
  animGraphEdgeTypes,
  animGraphNodeTypes,
} from "@babylonslate/graph-ui";
import type { Diagnostic } from "@babylonslate/scripting";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useAnimGraphEditing } from "../context/anim-graph-editing-context";
import { useValidation } from "../context/validation-context";
import {
  defaultNodeRegistry,
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
  validateSerializedGraph,
} from "../services/graph-validation";

const VARIABLE_TYPE_OPTIONS: Array<{ value: AnimVariableTypeId; label: string }> =
  [
    { value: "bool", label: "Bool" },
    { value: "int", label: "Int" },
    { value: "float", label: "Float" },
    { value: "string", label: "String" },
  ];

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

function uniqueVariableId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.variables.map((variable) => variable.id));
  let index = 1;
  while (ids.has(`var-${index}`)) index += 1;
  return `var-${index}`;
}

function uniqueVariableName(doc: AnimGraphDocument, base = "Variable"): string {
  const names = new Set(doc.variables.map((variable) => variable.name));
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

function withVariables(
  doc: AnimGraphDocument,
  variables: AnimGraphVariable[],
): AnimGraphDocument {
  return {
    ...doc,
    variables,
    parameters: variables
      .filter((variable) => variable.typeId === "bool")
      .map((variable) => variable.name),
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

function transitionLabel(doc: AnimGraphDocument, transition: AnimTransition): string {
  const from =
    doc.states.find((state) => state.id === transition.fromStateId)?.name ??
    transition.fromStateId;
  const to =
    doc.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  return `${from} To ${to}`;
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
  return { doc, commit, assetRegistry, documentId };
}

function AnimGraphVariablesList({
  showStates,
}: {
  showStates: boolean;
}) {
  const { doc, commit } = useAnimGraphDocument();
  const { selectedId, setSelectedId } = useAnimGraphEditing();
  return (
    <PanelFrame>
      <div className="flex flex-col gap-4 p-3">
        <div className="flex flex-col gap-2" data-testid="anim-graph-parameters">
          <div className="text-sm font-medium">Variables</div>
          {doc.variables.map((variable) => (
            <div
              key={variable.id}
              className="rounded-md border border-border p-2"
              data-testid={`anim-graph-variable-${variable.id}`}
            >
              <PropertyGrid
                rows={[
                  {
                    id: `${variable.id}-name`,
                    kind: "text",
                    label: "Name",
                    value: variable.name,
                    onChange: (name) =>
                      commit(
                        withVariables(
                          doc,
                          doc.variables.map((row) =>
                            row.id === variable.id ? { ...row, name } : row,
                          ),
                        ),
                      ),
                  },
                  {
                    id: `${variable.id}-type`,
                    kind: "enum",
                    label: "Type",
                    value: variable.typeId,
                    options: VARIABLE_TYPE_OPTIONS,
                    onChange: (value) => {
                      const typeId = value as AnimVariableTypeId;
                      commit(
                        withVariables(
                          doc,
                          doc.variables.map((row) =>
                            row.id === variable.id
                              ? {
                                  ...row,
                                  typeId,
                                  defaultValue: defaultAnimVariableValue(typeId),
                                }
                              : row,
                          ),
                        ),
                      );
                    },
                  },
                ]}
              />
              <Button
                type="button"
                variant="ghost"
                className="mt-2 min-h-[var(--touch-target,44px)]"
                data-testid={`anim-graph-variable-remove-${variable.id}`}
                onClick={() =>
                  commit(
                    withVariables(
                      doc,
                      doc.variables.filter((row) => row.id !== variable.id),
                    ),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] w-fit"
            data-testid="anim-graph-add-variable"
            onClick={() => {
              const typeId: AnimVariableTypeId = "bool";
              commit(
                withVariables(doc, [
                  ...doc.variables,
                  {
                    id: uniqueVariableId(doc),
                    name: uniqueVariableName(doc),
                    typeId,
                    defaultValue: defaultAnimVariableValue(typeId),
                  },
                ]),
              );
            }}
          >
            Add Variable
          </Button>
        </div>
        {showStates ? (
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
        ) : null}
      </div>
    </PanelFrame>
  );
}

export function AnimGraphParametersPanel(_props: IDockviewPanelProps) {
  void _props;
  return <AnimGraphVariablesList showStates />;
}

export function AnimGraphVariablesPanel(_props: IDockviewPanelProps) {
  void _props;
  return <AnimGraphVariablesList showStates />;
}

export function AnimObjectVariablesPanel(_props: IDockviewPanelProps) {
  void _props;
  return <AnimGraphVariablesList showStates={false} />;
}

export function AnimGraphGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, commit, documentId } = useAnimGraphDocument();
  const {
    selectedId,
    setSelectedId,
    setSelectedTransitionId,
    openTransitionId,
    openTransitionRule,
    closeTransitionRule,
  } = useAnimGraphEditing();
  const { activeDocumentId, animEditorMode } = useDocuments();
  const { setDiagnostics, diagnostics } = useValidation();
  const graphDiagnostics = useMemo(
    () =>
      diagnostics.map((row) => ({
        nodeId: row.nodeId,
        pinId: row.pinId,
        severity: row.severity,
        message: row.message,
      })),
    [diagnostics],
  );
  const openTransition =
    openTransitionId
      ? (doc.transitions.find((row) => row.id === openTransitionId) ?? null)
      : null;
  const initialGraph = useMemo(
    () => hydrateAnimGraphForEditor(animGraphToSerialized(doc)),
    [doc],
  );
  const ruleMembers = useMemo(
    () => animGraphMembersFromVariables(doc.variables),
    [doc.variables],
  );
  const ruleGraph = useMemo(() => {
    if (!openTransition) return null;
    return hydrateSerializedGraphForEditor(
      { ...openTransition.ruleGraph, members: ruleMembers },
      defaultNodeRegistry,
    );
  }, [openTransition, ruleMembers]);
  const rulePalette = useMemo(
    () =>
      scriptPaletteNodes(defaultNodeRegistry, {
        parentClass: "BObject",
        animationGraphHost: "rule",
        graph: { nodes: [], edges: [], members: ruleMembers },
      }),
    [ruleMembers],
  );

  useEffect(() => {
    if (activeDocumentId !== documentId) return;
    if (animEditorMode !== "stateMachine") return;
    const animRows: Diagnostic[] = validateAnimGraph(doc).map((row) => ({
      severity: row.severity,
      code: row.code,
      message: row.message,
      assetGuid: documentId,
      graphId: documentId,
      nodeId: row.nodeId,
    }));
    const ruleRows =
      openTransition && ruleGraph
        ? validateSerializedGraph(ruleGraph, {
            assetGuid: documentId,
            graphId: `${documentId}:${openTransition.id}`,
            members: ruleMembers.map((member) => ({
              id: member.id,
              name: member.name,
              kind: "variable" as const,
              classId: "AnimGraph",
              typeId: member.typeId ?? "bool",
            })),
          })
        : [];
    setDiagnostics([...animRows, ...ruleRows]);
  }, [
    activeDocumentId,
    animEditorMode,
    doc,
    documentId,
    openTransition,
    ruleGraph,
    ruleMembers,
    setDiagnostics,
  ]);

  if (openTransition && ruleGraph) {
    return (
      <PanelFrame className="flex-1">
        <div className="flex h-full min-h-0 flex-col" data-testid="anim-rule-graph">
          <ToolbarStrip>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="anim-rule-breadcrumb-state-machine"
              onClick={closeTransitionRule}
            >
              State Machine
            </Button>
            <span className="px-2 text-sm" data-testid="anim-rule-breadcrumb">
              {transitionLabel(doc, openTransition)}
            </span>
          </ToolbarStrip>
          <GraphEditor
            key={openTransition.id}
            initialGraph={ruleGraph}
            paletteNodes={rulePalette}
            diagnostics={graphDiagnostics}
            onChange={(next) => {
              const nextRule = { nodes: next.nodes, edges: next.edges };
              const transitionId = openTransition.id;
              queueMicrotask(() => {
                commit(patchTransition(doc, transitionId, { ruleGraph: nextRule }));
              });
            }}
          />
        </div>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame className="flex-1">
      <div className="flex h-full min-h-0 flex-col" data-testid="anim-graph-editor">
        <GraphEditor
          initialGraph={initialGraph}
          paletteNodes={animPaletteNodes()}
          nodeTypes={animGraphNodeTypes}
          edgeTypes={animGraphEdgeTypes}
          defaultEdgeOptions={{ type: "animTransition" }}
          diagnostics={graphDiagnostics}
          focusedNodeId={selectedId ?? undefined}
          onSelectionChange={(nodeIds) => {
            queueMicrotask(() => setSelectedId(nodeIds[0] ?? null));
          }}
          onEdgeSelectionChange={(edgeIds) => {
            queueMicrotask(() => setSelectedTransitionId(edgeIds[0] ?? null));
          }}
          onEdgeDoubleClick={(edgeId) => openTransitionRule(edgeId)}
          onChange={(next) => {
            const updated = serializedToAnimGraph(next, doc);
            const keepSelection = selectedId;
            queueMicrotask(() => {
              if (
                keepSelection &&
                !updated.states.some((state) => state.id === keepSelection)
              ) {
                setSelectedId(null);
              }
              commit(updated);
            });
          }}
        />
      </div>
    </PanelFrame>
  );
}

function transitionPropertyRows(
  doc: AnimGraphDocument,
  transition: AnimTransition,
  commit: (next: AnimGraphDocument) => void,
): { rows: PropertyRow[]; openRuleId: string } {
  const target =
    doc.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  return {
    rows: [
      {
        id: `${transition.id}-blendSeconds`,
        kind: "number",
        label: `To ${target} Blend Seconds`,
        value: transition.blendSeconds,
        min: 0,
        onChange: (blendSeconds) =>
          commit(patchTransition(doc, transition.id, { blendSeconds })),
      },
      {
        id: `${transition.id}-priority`,
        kind: "number",
        label: `To ${target} Priority`,
        value: transition.priority,
        onChange: (priority) =>
          commit(patchTransition(doc, transition.id, { priority })),
      },
    ],
    openRuleId: transition.id,
  };
}

export function AnimGraphDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, commit, assetRegistry } = useAnimGraphDocument();
  const { selectedId, selectedTransitionId, openTransitionRule } =
    useAnimGraphEditing();
  const [clipPick, setClipPick] = useState(false);
  const selected = doc.states.find((state) => state.id === selectedId) ?? null;
  const selectedTransition =
    doc.transitions.find((row) => row.id === selectedTransitionId) ?? null;
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
    : selectedTransition
      ? [selectedTransition]
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
  const transitionBlocks = outgoing.map((transition) =>
    transitionPropertyRows(doc, transition, commit),
  );

  return (
    <PanelFrame>
      {selected || selectedTransition ? (
        <div data-testid="anim-graph-details">
          {stateRows.length > 0 ? <PropertyGrid rows={stateRows} /> : null}
          {transitionBlocks.map((block) => (
            <div key={block.openRuleId} className="flex flex-col gap-2 px-3 pb-3">
              <PropertyGrid rows={block.rows} />
              <Button
                type="button"
                variant="outline"
                className="min-h-[var(--touch-target,44px)] w-fit"
                data-testid={`anim-graph-open-rule-${block.openRuleId}`}
                onClick={() => openTransitionRule(block.openRuleId)}
              >
                Open Rule
              </Button>
            </div>
          ))}
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
