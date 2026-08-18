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
  findReverseTransition,
  hydrateAnimGraphForEditor,
  normalizeAnimConnection,
  parseAnimGraphDocument,
  resolveAnimGraphClips,
  serializedToAnimGraph,
  setTransitionBidirectional,
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
  SearchDropdown,
  ToolbarStrip,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { cn } from "@babylonslate/ui/lib/utils";
import { Trash2Icon } from "lucide-react";
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
import { animClipCatalogFromAssets } from "../lib/anim-clip-catalog";
import { IconActionButton } from "./icon-action-button";

const VARIABLE_TYPE_OPTIONS: Array<{ value: AnimVariableTypeId; label: string }> =
  [
    { value: "bool", label: "Bool" },
    { value: "int", label: "Int" },
    { value: "float", label: "Float" },
    { value: "string", label: "String" },
  ];

function asAnimGraph(
  payload: Record<string, unknown>,
  catalog: Parameters<typeof resolveAnimGraphClips>[1] = [],
): AnimGraphDocument {
  return resolveAnimGraphClips(
    parseAnimGraphDocument(payload) ?? createDefaultAnimGraph(),
    catalog,
  );
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
  const listed = assetRegistry?.list() ?? [];
  const catalogKey = listed
    .map(
      (asset) =>
        `${asset.header.guid}:${asset.header.type}:${JSON.stringify(asset.header.payload ?? {})}`,
    )
    .join("|");
  const catalog = useMemo(
    () => animClipCatalogFromAssets(listed),
    // listed is rebuilt each render; catalogKey is the actual input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogKey],
  );
  const doc = useMemo(
    () =>
      asAnimGraph((entry?.content ?? {}) as Record<string, unknown>, catalog),
    [entry?.content, catalog],
  );
  const commit = (next: AnimGraphDocument) => {
    void applyAssetDocumentChange(
      documentId,
      next as unknown as Record<string, unknown>,
    );
  };
  return { doc, commit, assetRegistry, documentId, catalog };
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
      <div className="flex flex-col gap-3 p-2">
        <div className="flex flex-col gap-1" data-testid="anim-graph-parameters">
          <div className="flex items-center justify-between gap-1 px-1">
            <div className="text-sm font-medium">Variables</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
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
          {doc.variables.map((variable) => (
            <div
              key={variable.id}
              className="flex min-h-[var(--chrome-row,28px)] items-center gap-1 px-1"
              data-testid={`anim-graph-variable-${variable.id}`}
            >
              <Input
                className="h-7 min-h-7 min-w-0 flex-1"
                value={variable.name}
                aria-label="Variable Name"
                data-testid={`anim-graph-variable-name-${variable.id}`}
                onChange={(event) =>
                  commit(
                    withVariables(
                      doc,
                      doc.variables.map((row) =>
                        row.id === variable.id
                          ? { ...row, name: event.target.value }
                          : row,
                      ),
                    ),
                  )
                }
              />
              <Select
                value={variable.typeId}
                onValueChange={(value) => {
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
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-24"
                  aria-label="Variable Type"
                  data-testid={`anim-graph-variable-type-${variable.id}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VARIABLE_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <IconActionButton
                label="Remove Variable"
                variant="ghost"
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
                <Trash2Icon />
              </IconActionButton>
            </div>
          ))}
        </div>
        {showStates ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-1 px-1">
              <div className="text-sm font-medium">States</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="anim-graph-add-state"
                onClick={() => commit(addAnimState(doc))}
              >
                Add State
              </Button>
            </div>
            {doc.states.map((state) => (
              <Button
                key={state.id}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full justify-start rounded-none border-l-2",
                  selectedId === state.id
                    ? "border-l-primary bg-primary/20"
                    : "border-l-transparent",
                )}
                aria-pressed={selectedId === state.id}
                data-testid={`anim-graph-state-${state.id}`}
                onClick={() => setSelectedId(state.id)}
              >
                {state.name}
              </Button>
            ))}
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
  const { doc, commit, documentId, catalog } = useAnimGraphDocument();
  const {
    selectedId,
    setSelectedId,
    setSelectedTransitionId,
    focusedNodeId,
    openTransitionId,
    openTransitionRule,
    closeTransitionRule,
  } = useAnimGraphEditing();
  const { activeDocumentId, animEditorMode } = useDocuments();
  const { setDiagnostics, diagnostics, focusDiagnostic } = useValidation();
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
    const animRows: Diagnostic[] = validateAnimGraph(doc, catalog).map((row) => ({
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
    catalog,
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
          defaultEdgeOptions={{
            type: "animTransition",
          }}
          diagnostics={graphDiagnostics}
          selectedNodeId={selectedId ?? undefined}
          focusedNodeId={focusDiagnostic?.nodeId ?? focusedNodeId ?? undefined}
          connectEndMode="zone-add-node"
          connectionMode="loose"
          uniqueDirectedPairOnConnect
          normalizeConnection={(connection) => {
            const next = normalizeAnimConnection(connection);
            if (!next) return null;
            return { ...connection, ...next };
          }}
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
): { rows: PropertyRow[]; openRuleId: string; reverseRuleId: string | null } {
  const target =
    doc.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  const reverse = findReverseTransition(
    doc.transitions,
    transition.fromStateId,
    transition.toStateId,
  );
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
      {
        id: `${transition.id}-direction`,
        kind: "enum",
        label: "Direction",
        value: reverse ? "bothWays" : "oneWay",
        options: [
          { value: "oneWay", label: "One Way" },
          { value: "bothWays", label: "Both Ways" },
        ],
        onChange: (value) =>
          commit(
            setTransitionBidirectional(doc, transition.id, value === "bothWays"),
          ),
      },
    ],
    openRuleId: transition.id,
    reverseRuleId: reverse?.id ?? null,
  };
}

export function AnimGraphDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, commit, assetRegistry, catalog } = useAnimGraphDocument();
  const { selectedId, selectedTransitionId, openTransitionRule } =
    useAnimGraphEditing();
  const [clipPick, setClipPick] = useState(false);
  const [clipNameOpen, setClipNameOpen] = useState(false);
  const selected = doc.states.find((state) => state.id === selectedId) ?? null;
  const selectedTransition =
    doc.transitions.find((row) => row.id === selectedTransitionId) ?? null;
  const clip = selected?.clipId
    ? doc.clips.find((row) => row.id === selected.clipId)
    : undefined;
  const clipKind: AnimClipKind = clip?.kind ?? "animation";
  const clipAssetType = catalog.find((entry) => entry.guid === clip?.assetGuid)
    ?.type;
  const clipNameOptions = (
    clipKind === "animation" && clipAssetType === "Model"
      ? (catalog.find((entry) => entry.guid === clip?.assetGuid)?.clipNames ??
        [])
      : []
  ).map((name) => ({ value: name, label: name }));
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
  const applyClipAsset = (guid: string) => {
    if (!selected) return;
    const entry = catalog.find((row) => row.guid === guid);
    const names = entry?.clipNames ?? [];
    const nextName =
      clipKind === "sprite"
        ? ""
        : entry?.type === "Animation"
          ? (entry.clipName ?? "")
          : names.includes(clip?.clipName ?? "")
            ? clip?.clipName
            : (names[0] ?? "");
    commit(
      upsertStateClip(doc, selected.id, {
        assetGuid: guid,
        clipName: nextName,
        ...(typeof entry?.durationMs === "number"
          ? { durationMs: entry.durationMs }
          : {}),
      }),
    );
  };
  const identityRows: PropertyRow[] = selected
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
          onChange: (value) => applyClipAsset(value ?? ""),
          ...assetRowIdentity(
            clip?.assetGuid
              ? (() => {
                  const asset = assetRegistry?.getByGuid(clip.assetGuid);
                  return asset
                    ? { name: asset.header.name, type: asset.header.type }
                    : {
                        name: clip.assetGuid,
                        type:
                          clipKind === "sprite" ? "SpriteAnimation" : "Animation",
                      };
                })()
              : undefined,
          ),
        },
      ]
    : [];
  const playbackRows: PropertyRow[] = selected
    ? [
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
          {identityRows.length > 0 ? <PropertyGrid rows={identityRows} /> : null}
          {selected && clipKind === "animation" && clipAssetType === "Model" ? (
            <Field
              data-testid="property-row-clipName"
              data-disabled={clipNameOptions.length === 0 || undefined}
              className="gap-0.5 border-b border-border/60 px-2 py-1"
            >
              <FieldLabel htmlFor="property-clipName">Clip Name</FieldLabel>
              {clipNameOptions.length > 0 ? (
                <SearchDropdown
                  open={clipNameOpen}
                  onOpenChange={setClipNameOpen}
                  title="Clip Name"
                  items={clipNameOptions.map((option) => ({
                    id: option.value,
                    label: option.label,
                  }))}
                  onSelect={(id) => {
                    commit(
                      upsertStateClip(doc, selected.id, { clipName: id }),
                    );
                    setClipNameOpen(false);
                  }}
                  data-testid="anim-graph-clip-name-menu"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    id="property-clipName"
                    data-testid="property-clipName"
                    className="w-full justify-start"
                  >
                    {clip?.clipName || "Select Clip"}
                  </Button>
                </SearchDropdown>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  id="property-clipName"
                  data-testid="property-clipName"
                  disabled
                  className="w-full justify-start"
                >
                  No Clips
                </Button>
              )}
            </Field>
          ) : null}
          {playbackRows.length > 0 ? <PropertyGrid rows={playbackRows} /> : null}
          {transitionBlocks.map((block) => (
            <div key={block.openRuleId} className="flex flex-col gap-2 px-3 pb-3">
              <PropertyGrid rows={block.rows} />
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={`anim-graph-open-rule-${block.openRuleId}`}
                  onClick={() => openTransitionRule(block.openRuleId)}
                >
                  Open Rule
                </Button>
                {block.reverseRuleId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`anim-graph-open-rule-${block.reverseRuleId}`}
                    onClick={() => openTransitionRule(block.reverseRuleId!)}
                  >
                    Open Reverse Rule
                  </Button>
                ) : null}
              </div>
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
        allowedTypes={clipKind === "sprite" ? ["SpriteAnimation"] : ["Animation"]}
        title={
          clipKind === "sprite" ? "Pick Sprite Animation" : "Pick Animation"
        }
        allowNone
        onPick={(guid) => {
          applyClipAsset(guid ?? "");
          setClipPick(false);
        }}
        data-testid="anim-graph-clip-picker"
      />
    </PanelFrame>
  );
}
