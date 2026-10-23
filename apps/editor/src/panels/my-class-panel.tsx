import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AddMemberMenu,
  AssetPicker,
  ContextMenuOverlay,
  NamePromptDialog,
  PanelFrame,
  PinTypeMenu,
  TreeView,
  PinShapeGlyph,
  TypeColorMark,
  formatEventMemberName,
  pinShapeForContainer,
  formatEventTitle,
  pinPickerColorVar,
  rangeSelectTreeIds,
  useContextMenu,
  type ContextMenuItem,
  type TreeSelectOptions,
  type TreeViewNode,
} from "@haptic/editor-kit";
import {
  classMemberCategoryPath,
  type GraphClassMemberKind,
  type SerializedGraph,
} from "@haptic/core";
import { isLockedEngineClassId } from "@haptic/object-model";
import { isTouchEventNodeType } from "@haptic/scripting";
import { nextCopyName } from "@haptic/assets";
import { Alert, AlertDescription } from "@haptic/ui/components/alert";
import { Badge } from "@haptic/ui/components/badge";
import {
  addClassMember,
  addVariableAccessNode,
  blueprintSectionsForClass,
  classAllowsMemberKind,
  ensureEventNodeOnGraph,
  isObjectInstanceVariableType,
  memberNamePromptCopy,
  nativeStubId,
  nextNewMemberName,
  variableFieldsForPickerType,
  patchClassMember,
  removeClassMember,
  canDropClassMember,
  completeClassMemberDrop,
  dropVariableBinding,
  droppedRowsNotice,
  resolveClassMemberDrop,
  type ClassMemberDropRow,
  type GraphDropPoint,
  type VariableAccessKind,
} from "../lib/class-members";
import {
  canCopyClassMembers,
  classAncestorGraphs,
  copyClassMembers,
  pasteClassMembers,
  skippedMembersNotice,
  type ClassMemberCopyRow,
} from "../lib/class-member-clipboard";
import { MemberAccessChooser } from "../components/member-access-chooser";
import { FolderIcon, PlusIcon } from "lucide-react";
import { GraphDropHint, type GraphDropHintState } from "@haptic/graph-ui";
import {
  useDocumentActions,
  useRegistryState,
  useOpenDocument,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useEditorSessionState } from "../context/editor-session-state-context";
import { useKeybindCommand, useKeybindings } from "../context/keybind-context";
import { useValidation } from "../context/validation-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useWatchStore } from "../context/watch-store-context";
import { defaultNodeRegistry } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { IconActionButton } from "../components/icon-action-button";
import { usePhoneTouchSizing } from "../shell/use-platform-layout";
import { classParentLookup } from "../lib/content-browser-helpers";
import {
  collectClassGraphsForPalette,
  collectScriptInterfacesForPalette,
  commitLogicGraph,
  serializedGraphFromDocument,
} from "../lib/logic-graph-document";
import {
  collectOverridableEventRows,
  collectOverridableFunctionRows,
} from "../lib/overridable-functions";
import { componentGraphMembersForClass } from "../lib/component-graph-members";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import {
  EVENT_GRAPH_PANEL_ID,
  openFunctionGraphPanel,
} from "../shell/function-graph-panels";

const CLASS_KINDS = ["graph"] as const;
const INTERFACE_KINDS = ["script-interface"] as const;

export type MyClassMember = {
  kind: "variable" | "function" | "event" | "interface";
  name: string;
  detail?: string;
  inherited?: boolean;
  /** Declaring parent class id when `inherited` is set. */
  inheritedFrom?: string;
  eventType?: string;
  typeId?: string;
  typeClassId?: string;
  container?: string;
  functionId?: string;
  assetGuid?: string;
  pins?: import("@haptic/core").GraphClassMemberPin[];
  hasError?: boolean;
  componentId?: string;
  /** Class tree folder path; `|` separates subcategories. */
  category?: string;
};

export type MyClassPanelProps = IDockviewPanelProps;

/** The Class tree row id of a member. */
function rowIdOf(member: MyClassMember): string {
  return member.detail ?? `${member.kind}-${member.name}`;
}

function dropRowOf(member: MyClassMember): ClassMemberDropRow {
  return {
    id: rowIdOf(member),
    kind: member.kind,
    name: member.name,
    eventType: member.eventType,
    inherited: member.inherited,
    inheritedFrom: member.inheritedFrom,
    pins: member.pins,
    typeId: member.typeId,
    typeClassId: member.typeClassId,
    componentId: member.componentId,
  };
}

/** How long a floating notice stays up. */
const NOTICE_MS = 4000;

function sectionsForTree(
  activeFunctionId?: string | null,
  options?: MembersForGraphOptions,
) {
  return blueprintSectionsForClass({
    parentClass: options?.parentClass,
    parentOf: options?.parentOf,
    activeFunctionId,
    assetType: options?.assetType,
  });
}

export type MembersForGraphOptions = {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
  assetType?: string | null;
  classId?: string;
  scriptInterfaces?: Array<{
    guid: string;
    name: string;
    methods: Array<{
      name: string;
      pins?: import("@haptic/core").GraphClassMemberPin[];
    }>;
  }>;
};

/** Body name for a custom/native event node (no leading "Event "). */
function eventMemberBodyName(node: SerializedGraph["nodes"][number]): string {
  const named = node.data.name;
  if (typeof named === "string" && named.trim()) {
    return formatEventMemberName(named);
  }
  const title = node.data.title;
  if (typeof title === "string" && title.trim()) {
    return formatEventMemberName(title);
  }
  const catalog = defaultNodeRegistry.get(node.type)?.title;
  if (catalog) return formatEventMemberName(catalog);
  const typeName = node.type.startsWith("flow.event.")
    ? node.type.slice("flow.event.".length)
    : node.type;
  return formatEventMemberName(typeName);
}

/** Call Custom Event / Call Parent are canvas nodes, not Class Events members. */
function isFlowEventCallNode(type: string): boolean {
  return type === "flow.event.call" || type === "flow.event.callParent";
}

/** Display label for Class Events tree (native stubs keep Event … titles). */
function eventDisplayName(node: SerializedGraph["nodes"][number]): string {
  if (node.type === "flow.event.custom") {
    return eventMemberBodyName(node);
  }
  const title = node.data.title;
  if (typeof title === "string" && title.trim()) {
    return formatEventTitle(title);
  }
  const named = node.data.name;
  if (typeof named === "string" && named.trim()) {
    return formatEventTitle(named);
  }
  const catalog = defaultNodeRegistry.get(node.type)?.title;
  if (catalog) return formatEventTitle(catalog);
  const typeName = node.type.startsWith("flow.event.")
    ? node.type.slice("flow.event.".length)
    : node.type;
  return formatEventTitle(typeName);
}

function variablePickerType(member: Pick<MyClassMember, "typeId" | "typeClassId">): string {
  return member.typeId === "struct" && member.typeClassId === "engine:TagContainer" ? "tagContainer" : member.typeId ?? "float";
}

function memberIcon(member: MyClassMember) {
  if (member.kind === "variable") {
    const shape = pinShapeForContainer(member.container);
    const color = pinPickerColorVar(variablePickerType(member));
    const testId = `class-var-type-${member.detail ?? member.name}`;
    return shape === "circle" ? (
      <TypeColorMark colorVar={color} data-testid={testId} />
    ) : (
      <PinShapeGlyph shape={shape} connected outlined={false} color={color} size={12} data-testid={testId} />
    );
  }
  if (member.kind === "function") {
    return <TypeColorMark colorVar="var(--node-function)" />;
  }
  if (member.kind === "event") {
    return <TypeColorMark colorVar="var(--node-event)" />;
  }
  return <TypeColorMark colorVar="var(--asset-script-type)" />;
}

function inheritedMembers(
  options: MembersForGraphOptions | undefined,
): MyClassMember[] {
  if (!options?.parentGraphs) return [];
  const parentOf = options.parentOf;
  const chain: string[] = [];
  let current = options.parentClass ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf?.(current) ?? null;
  }
  const rows: MyClassMember[] = [];
  const seenKeys = new Set<string>();
  const push = (row: MyClassMember) => {
    const key = `${row.kind}:${row.name}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    rows.push(row);
  };
  for (const className of chain) {
    const parentGraph = options.parentGraphs[className];
    if (!parentGraph) continue;
    for (const member of parentGraph.members ?? []) {
      if (member.kind === "variable" && member.functionId) continue;
      if (member.kind === "event") continue;
      if (
        member.kind === "variable" ||
        member.kind === "function" ||
        member.kind === "interface"
      ) {
        push({
          kind: member.kind,
          name: member.name,
          detail: nativeStubId(`${member.kind}:${className}:${member.name}`),
          inherited: true,
          inheritedFrom: className,
          ...(member.typeId ? { typeId: member.typeId } : {}),
          ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
          ...(member.container && member.container !== "single"
            ? { container: member.container }
            : {}),
          ...(member.assetGuid ? { assetGuid: member.assetGuid } : {}),
          ...(member.pins ? { pins: member.pins } : {}),
          ...(member.category ? { category: member.category } : {}),
        });
      }
    }
  }
  return rows;
}

function isClassTreeEventNode(type: string): boolean {
  if (isFlowEventCallNode(type)) return false;
  return type === "input.actionEvent" || type === "input.axisEvent" || type === "input.onAnyKeyPressed" || isTouchEventNodeType(type)
    || type.startsWith("flow.event.") || type.startsWith("bt.event.");
}

/**
 * Members the current graph declares. Events come from canvas nodes that are
 * on the graph; unused natives and inherited customs stay in Events +.
 */
export function membersForGraph(
  graph: SerializedGraph | null,
  options?: MembersForGraphOptions,
): MyClassMember[] {
  if (!graph) return [];
  const declared = (graph.members ?? [])
    .filter((member) => member.kind !== "event")
    .map((member) => ({
      kind: member.kind,
      name: member.name,
      detail: member.id,
      ...(member.typeId ? { typeId: member.typeId } : {}),
      ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
      ...(member.container && member.container !== "single"
        ? { container: member.container }
        : {}),
      ...(member.functionId ? { functionId: member.functionId } : {}),
      ...(member.assetGuid ? { assetGuid: member.assetGuid } : {}),
      ...(member.pins ? { pins: member.pins } : {}),
      ...(member.category ? { category: member.category } : {}),
    }));
  const declaredKeys = new Set(
    declared.map((member) => `${member.kind}:${member.name}`),
  );
  const events: MyClassMember[] = [];
  for (const node of graph.nodes) {
    if (!isClassTreeEventNode(node.type)) continue;
    events.push({
      kind: "event",
      name: eventDisplayName(node),
      detail: node.id,
      eventType: node.type,
      ...(Array.isArray(node.data.pins)
        ? { pins: node.data.pins as NonNullable<MyClassMember["pins"]> }
        : {}),
    });
  }
  const inherited = inheritedMembers(options).filter(
    (row) => !declaredKeys.has(`${row.kind}:${row.name}`),
  );
  const componentRefs: MyClassMember[] = componentGraphMembersForClass({
    graph,
    classId: options?.classId,
    parentClass: options?.parentClass,
    parentOf: options?.parentOf,
    parentGraphs: options?.parentGraphs,
  }).map((member) => ({
    kind: "variable",
    name: member.name,
    detail: member.id,
    typeId: member.typeId,
    typeClassId: member.typeClassId,
    componentId: member.componentId,
    ...(member.category ? { category: member.category } : {}),
    ...(member.inheritedFrom
      ? { inherited: true, inheritedFrom: member.inheritedFrom }
      : {}),
  }));
  return [...declared, ...componentRefs, ...events, ...inherited];
}

type CategoryFolder = {
  path: string;
  name: string;
  folders: Map<string, CategoryFolder>;
  members: MyClassMember[];
};

/** Section members nested into category folders, in first-seen order. */
function categoryFolderTree(members: MyClassMember[]): CategoryFolder {
  const root: CategoryFolder = { path: "", name: "", folders: new Map(), members: [] };
  for (const member of members) {
    let folder = root;
    for (const segment of classMemberCategoryPath(member.category)) {
      let child = folder.folders.get(segment);
      if (!child) {
        child = {
          path: folder.path ? `${folder.path}|${segment}` : segment,
          name: segment,
          folders: new Map(),
          members: [],
        };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.members.push(member);
  }
  return root;
}

/** Collapse key for a category folder row (`section-` prefixed in the tree id). */
function categoryFolderKey(sectionId: string, path: string): string {
  return `${sectionId}|${path}`;
}

function memberTreeNode(
  member: MyClassMember,
  sectionId: string,
  depth: number,
): TreeViewNode {
  return {
    id: member.detail ?? `${sectionId}-${member.name}`,
    label: member.name,
    depth,
    hasChildren: false,
    expanded: false,
    muted: member.hasError,
    icon: memberIcon(member),
    draggable: canDropClassMember(member),
    trailing: member.inherited ? (
      <Badge
        variant="secondary"
        className="px-1 py-0 text-[9px] leading-4"
        data-testid={`inherited-badge-${member.detail ?? member.name}`}
      >
        Inherited
      </Badge>
    ) : undefined,
  };
}

export function blueprintTreeNodes(
  members: MyClassMember[],
  collapsed: ReadonlySet<string>,
  options?: MembersForGraphOptions & { activeFunctionId?: string | null },
): TreeViewNode[] {
  const rows: TreeViewNode[] = [];
  for (const section of sectionsForTree(options?.activeFunctionId, options)) {
    const kids = members.filter((member) => {
      if (section.id === "local-variables") {
        return (
          member.kind === "variable" &&
          member.functionId === options?.activeFunctionId
        );
      }
      if (section.kind === "variable") {
        return member.kind === "variable" && !member.functionId;
      }
      return member.kind === section.kind;
    });
    const expanded = !collapsed.has(section.id);
    rows.push({
      id: `section-${section.id}`,
      label: section.label,
      depth: 0,
      hasChildren: true,
      expanded,
      draggable: false,
    });
    if (!expanded) continue;
    const pushFolder = (folder: CategoryFolder, depth: number) => {
      for (const child of folder.folders.values()) {
        const key = categoryFolderKey(section.id, child.path);
        const childExpanded = !collapsed.has(key);
        rows.push({
          id: `section-${key}`,
          label: child.name,
          depth,
          hasChildren: true,
          expanded: childExpanded,
          icon: <FolderIcon />,
          draggable: false,
        });
        if (childExpanded) pushFolder(child, depth + 1);
      }
      for (const member of folder.members) {
        rows.push(memberTreeNode(member, section.id, depth));
      }
    };
    pushFolder(categoryFolderTree(kids), 1);
  }
  return rows;
}

export function ClassMembersView({
  graph,
  onGraphChange,
  selectedId,
  onSelectMember,
  onFocusEventNode,
  interfaceAssets,
  membersOptions,
  activeFunctionId,
  classId,
  classPath,
  canvasDropApi,
  onOpenInherited,
}: {
  graph: SerializedGraph | null;
  onGraphChange: (next: SerializedGraph) => void;
  selectedId?: string | null;
  onSelectMember?: (id: string, member: MyClassMember | undefined) => void;
  /** Focus a node in the graph just committed by the creation dialog. */
  onFocusEventNode?: (nodeId: string, name: string) => void;
  interfaceAssets?: Array<{ guid: string; name: string; type: string }>;
  membersOptions?: MembersForGraphOptions;
  activeFunctionId?: string | null;
  classId?: string;
  /** The Class asset path: with it, a variable's menu adds or removes a watch. */
  classPath?: string;
  canvasDropApi?: GraphDropPoint | null;
  onOpenInherited?: (member: MyClassMember) => void;
}) {
  const watchStore = useWatchStore();
  const touchSizing = usePhoneTouchSizing();
  const keybinds = useKeybindings();
  const sessionState = useEditorSessionState();
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [memberPromptKind, setMemberPromptKind] =
    useState<GraphClassMemberKind | null>(null);
  const [memberPromptLocal, setMemberPromptLocal] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [interfacePickerOpen, setInterfacePickerOpen] = useState(false);
  const [accessDrop, setAccessDrop] = useState<{
    memberIds: string[];
    position: { x: number; y: number };
    skipped: string[];
  } | null>(null);
  const [dropHint, setDropHint] = useState<GraphDropHintState | null>(null);
  // The selected entries when there are several; `primary` is the one the
  // graph follows and always equals `selectedId` while this applies.
  const [multi, setMulti] = useState<{ primary: string; ids: string[] } | null>(null);
  // Where a Shift range starts: the entry last chosen without Shift.
  const anchor = useRef<string | null>(null);
  // A fresh object per notice, so a second one restarts the timer.
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const showNotice = (message: string | null) => {
    if (message) setNotice({ message });
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const members = useMemo(
    () => membersForGraph(graph, membersOptions),
    [graph, membersOptions],
  );
  const rowById = useMemo(
    () => new Map(members.map((member) => [rowIdOf(member), member])),
    [members],
  );
  const treeSections = sectionsForTree(activeFunctionId, membersOptions);
  const renamableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const member of graph?.members ?? []) {
      if (member.kind === "variable" || member.kind === "function") ids.add(member.id);
      else if (
        member.kind === "event" &&
        graph?.nodes.some((node) => node.id === member.id && node.type === "flow.event.custom")
      ) {
        ids.add(member.id);
      }
    }
    return ids;
  }, [graph]);
  const namesOfKind = (kind: GraphClassMemberKind) =>
    members.filter((member) => member.kind === kind).map((member) => member.name);
  const startRename = (id: string) => {
    if (renamableIds.has(id)) setRenamingId(id);
  };
  const finishRename = (id: string, name: string | null) => {
    setRenamingId(null);
    if (!graph || !name) return;
    const member = (graph.members ?? []).find((entry) => entry.id === id);
    if (!member) return;
    const taken = members.some(
      (entry) =>
        entry.kind === member.kind &&
        entry.name === name &&
        (entry.detail ?? `${entry.kind}-${entry.name}`) !== id,
    );
    if (taken) return;
    onGraphChange(patchClassMember(graph, id, { name }, classId));
  };
  const addVariable = (pickerType: string, local: boolean) => {
    if (!graph) return;
    const next = addClassMember(
      graph,
      "variable",
      nextNewMemberName("variable", namesOfKind("variable")),
      undefined,
      {
        ...variableFieldsForPickerType(pickerType),
        ...(local && activeFunctionId ? { functionId: activeFunctionId } : {}),
      },
    );
    onGraphChange(next);
    const added = next.members?.[next.members.length - 1];
    if (!added) return;
    onSelectMember?.(added.id, {
      kind: added.kind,
      name: added.name,
      detail: added.id,
      typeId: added.typeId,
    });
    setRenamingId(added.id);
  };
  const addVariableRef = useRef(addVariable);
  addVariableRef.current = addVariable;
  const addKind = (kind: GraphClassMemberKind, local = false) => {
    if (kind === "interface") {
      setInterfacePickerOpen(true);
      return;
    }
    setMemberPromptLocal(local);
    setMemberPromptKind(kind);
  };
  const selectAddedFunction = (next: SerializedGraph, rename = false) => {
    onGraphChange(next);
    const added = next.members?.[next.members.length - 1];
    if (added) {
      onSelectMember?.(added.id, {
        kind: added.kind,
        name: added.name,
        detail: added.id,
        typeId: added.typeId,
      });
      if (rename) setRenamingId(added.id);
    }
  };
  const overridableEventRows = useMemo(
    () =>
      collectOverridableEventRows({
        graph: graph ?? undefined,
        classId,
        parentClass: membersOptions?.parentClass,
        parentOf: membersOptions?.parentOf,
        parentGraphs: membersOptions?.parentGraphs,
        assetType: membersOptions?.assetType,
      }),
    [classId, graph, membersOptions],
  );
  const overridableRows = useMemo(
    () =>
      collectOverridableFunctionRows({
        graph: graph ?? undefined,
        classId,
        parentOf: membersOptions?.parentOf,
        parentGraphs: membersOptions?.parentGraphs,
        scriptInterfaces: membersOptions?.scriptInterfaces,
      }),
    [classId, graph, membersOptions],
  );
  const createEmptyFunction = () => {
    if (!graph) return;
    selectAddedFunction(
      addClassMember(graph, "function", nextNewMemberName("function", namesOfKind("function"))),
      true,
    );
  };
  const pickFunction = (id: string) => {
    if (!graph) return;
    const row = overridableRows.find((entry) => entry.id === id);
    if (!row || row.overwritten) return;
    // Interface dispatch reads `implementsInterface`, not the function name, so
    // an implementation beside an unrelated function of that name takes a free one.
    const functionNames = namesOfKind("function");
    const name =
      row.kind === "interface" && functionNames.includes(row.name)
        ? nextCopyName(row.name, functionNames)
        : row.name;
    selectAddedFunction(
      addClassMember(graph, "function", name, undefined, {
        pins: row.pins,
        implementsInterface: row.implementsInterface,
        overrides: row.overrides,
      }),
    );
  };
  const createEmptyEvent = () => {
    if (!graph) return;
    const next = addClassMember(graph, "event", nextNewMemberName("event", namesOfKind("event")));
    onGraphChange(next);
    const node = next.nodes[next.nodes.length - 1];
    if (node) {
      onFocusEventNode?.(node.id, node.data.name as string);
      setRenamingId(node.id);
    }
  };
  const pickEvent = (id: string) => {
    if (!graph) return;
    const row = overridableEventRows.find((entry) => entry.id === id);
    if (!row || row.overwritten) return;
    const next =
      row.kind === "native"
        ? ensureEventNodeOnGraph(graph, row.eventType, { parentClassId: membersOptions?.parentClass })
        : row.kind === "component"
          ? ensureEventNodeOnGraph(graph, row.eventType, {
              name: row.eventType === "flow.event.custom" ? row.name : undefined,
              pins: row.pins,
              componentId: row.componentId,
              eventQualifier: row.eventQualifier,
            })
          : ensureEventNodeOnGraph(graph, "flow.event.custom", {
              name: row.name,
              pins: row.pins,
              parentClassId: row.parentClassId,
              eventQualifier: row.eventQualifier ?? "Inherited",
            });
    onGraphChange(next);
    const node = next.nodes.find((entry) => {
      if (entry.type !== row.eventType) return false;
      if (row.componentId) return entry.data.componentId === row.componentId;
      if (row.eventType !== "flow.event.custom") return true;
      return entry.data.name === row.name;
    });
    if (node) onFocusEventNode?.(node.id, row.name);
  };
  const addMenuRef = useRef({ createEmptyFunction, pickFunction, createEmptyEvent, pickEvent });
  addMenuRef.current = { createEmptyFunction, pickFunction, createEmptyEvent, pickEvent };
  const spawnAccess = (
    access: VariableAccessKind,
    memberId: string | null | undefined = selectedId,
  ) => {
    const row = memberId ? rowById.get(memberId) : undefined;
    if (!graph || !memberId || row?.kind !== "variable") return;
    onGraphChange(
      addVariableAccessNode(graph, dropVariableBinding(graph, dropRowOf(row)), access, {
        functionId: activeFunctionId,
        classId: row.inheritedFrom ?? classId,
      }),
    );
  };
  const dropMembers = (ids: readonly string[], clientX: number, clientY: number) => {
    if (!graph) return;
    const result = resolveClassMemberDrop({
      graph,
      memberIds: ids,
      members: members.map(dropRowOf),
      clientX,
      clientY,
      canvas: canvasDropApi ?? null,
      functionId: activeFunctionId,
      classId,
    });
    if (result.kind === "spawn") {
      onGraphChange(result.graph);
      showNotice(droppedRowsNotice(result.skipped));
      return;
    }
    if (result.kind === "choose-access") {
      setAccessDrop({
        memberIds: result.memberIds,
        position: result.position,
        skipped: result.skipped,
      });
    }
  };
  const chooseAccess = (access: VariableAccessKind) => {
    if (!graph || !accessDrop) return;
    const completed = completeClassMemberDrop({
      graph,
      memberIds: accessDrop.memberIds,
      members: members.map(dropRowOf),
      position: accessDrop.position,
      access,
      functionId: activeFunctionId,
      classId,
    });
    onGraphChange(completed.graph);
    showNotice(droppedRowsNotice(accessDrop.skipped, completed.skipped, access));
    setAccessDrop(null);
  };
  const nodes = useMemo(
    () =>
      blueprintTreeNodes(members, collapsed, {
        activeFunctionId,
        parentClass: membersOptions?.parentClass,
        parentOf: membersOptions?.parentOf,
        assetType: membersOptions?.assetType,
      }).map((row) => {
        if (!row.id.startsWith("section-")) return row;
        const sectionId = row.id.replace(/^section-/, "");
        const section = treeSections.find((entry) => entry.id === sectionId);
        if (!section) return row;
        const kind = section.kind;
        if (
          !classAllowsMemberKind(kind, {
            parentClass: membersOptions?.parentClass,
            parentOf: membersOptions?.parentOf,
            assetType: membersOptions?.assetType,
            local: section.local === true,
          })
        ) {
          return row;
        }
        const addLabel = `Add ${section.label.replace(/s$/, "")}`;
        if (kind === "variable") {
          return {
            ...row,
            trailing: (
              <PinTypeMenu
                title={`${addLabel} Type`}
                onSelect={(type) => addVariableRef.current(type, section.local === true)}
                data-testid={`class-add-${section.id}-menu`}
              >
                <IconActionButton
                  label={addLabel}
                  size={touchSizing ? "touch-icon" : "icon-sm"}
                  data-testid={`class-add-${section.id}`}
                >
                  <PlusIcon />
                </IconActionButton>
              </PinTypeMenu>
            ),
          };
        }
        if ((kind === "function" || kind === "event") && section.local !== true) {
          const event = kind === "event";
          return {
            ...row,
            trailing: (
              <AddMemberMenu
                title={addLabel}
                emptyLabel={event ? "New Event" : "New Function"}
                items={event ? overridableEventRows : overridableRows}
                onCreateEmpty={() =>
                  event
                    ? addMenuRef.current.createEmptyEvent()
                    : addMenuRef.current.createEmptyFunction()
                }
                onPick={(id) =>
                  event ? addMenuRef.current.pickEvent(id) : addMenuRef.current.pickFunction(id)
                }
                data-testid={event ? "add-event-menu" : "add-function-menu"}
              >
                <IconActionButton
                  label={addLabel}
                  size={touchSizing ? "touch-icon" : "icon-sm"}
                  data-testid={`class-add-${section.id}`}
                >
                  <PlusIcon />
                </IconActionButton>
              </AddMemberMenu>
            ),
          };
        }
        return {
          ...row,
          trailing: (
            <IconActionButton
              label={addLabel}
              size={touchSizing ? "touch-icon" : "icon-sm"}
              data-testid={`class-add-${section.id}`}
              onClick={(event) => {
                event.stopPropagation();
                addKind(kind, section.local === true);
              }}
            >
              <PlusIcon />
            </IconActionButton>
          ),
        };
      }).map((row) => renamableIds.has(row.id) ? { ...row, renamable: true } : row),
    [
      activeFunctionId,
      collapsed,
      members,
      membersOptions,
      treeSections,
      touchSizing,
      renamableIds,
      overridableRows,
      overridableEventRows,
    ],
  );

  const treeOrder = useMemo(() => {
    const order = new Map<string, number>();
    nodes.forEach((row, index) => order.set(row.id, index));
    return order;
  }, [nodes]);
  const inTreeOrder = (ids: readonly string[]) =>
    [...ids].sort(
      (left, right) => (treeOrder.get(left) ?? 1e9) - (treeOrder.get(right) ?? 1e9),
    );
  const selectionIds = useMemo(() => {
    if (multi && multi.primary === selectedId) {
      const live = multi.ids.filter((id) => rowById.has(id));
      if (live.length > 0) return live;
    }
    return selectedId ? [selectedId] : [];
  }, [multi, rowById, selectedId]);

  /**
   * Select entries; the graph follows `primary` like a single selection:
   * a function opens its tab, an event is focused, the Inspector shows it.
   * `refocus` follows it again even when it is already the primary one.
   */
  const applySelection = (ids: readonly string[], primary: string | null, refocus: boolean) => {
    if (primary === null || ids.length === 0) {
      setMulti(null);
      onSelectMember?.("", undefined);
      return;
    }
    setMulti(ids.length > 1 ? { primary, ids: [...ids] } : null);
    if (refocus || primary !== selectedId) onSelectMember?.(primary, rowById.get(primary));
  };
  /** Choose without Shift: the next range starts here. */
  const chooseEntries = (ids: readonly string[], primary: string | null, refocus: boolean) => {
    anchor.current = primary;
    applySelection(ids, primary, refocus);
  };
  const selectEntry = (id: string, options?: TreeSelectOptions) => {
    const current = selectionIds.filter((entry) => rowById.has(entry));
    if (options?.range) {
      // The range runs over the visible rows; section and folder rows are not members.
      const from = anchor.current && current.includes(anchor.current) ? anchor.current : current[current.length - 1];
      const range = rangeSelectTreeIds(
        nodes.map((row) => row.id),
        from,
        id,
      ).filter((entry) => rowById.has(entry));
      if (range.length === 0) return;
      applySelection(range, rowById.has(id) ? id : range[range.length - 1]!, true);
      return;
    }
    if (!rowById.has(id)) return;
    if (options?.additive) {
      if (!current.includes(id)) {
        chooseEntries([...current, id], id, true);
        return;
      }
      const rest = current.filter((entry) => entry !== id);
      chooseEntries(rest, rest[rest.length - 1] ?? null, false);
      return;
    }
    chooseEntries([id], id, true);
  };

  const copySource = {
    graph: graph ?? { nodes: [], edges: [] },
    classId,
    parentGraphs: membersOptions?.parentGraphs,
  };
  const copyRowsOf = (ids: readonly string[]): ClassMemberCopyRow[] =>
    inTreeOrder(ids).flatMap((id) => {
      const member = rowById.get(id);
      if (!member) return [];
      return [
        {
          id,
          kind: member.kind,
          name: member.name,
          ...(member.inherited && member.inheritedFrom ? { inheritedFrom: member.inheritedFrom } : {}),
          ...(member.componentId ? { componentId: member.componentId } : {}),
          ...(member.functionId ? { functionId: member.functionId } : {}),
        },
      ];
    });
  const canCopy = (ids: readonly string[]) =>
    Boolean(graph) && canCopyClassMembers(copyRowsOf(ids), copySource);
  const copyMembers = (ids: readonly string[]) => {
    if (!graph) return;
    const copied = copyClassMembers(copyRowsOf(ids), copySource);
    if (copied) sessionState.copyClassMembers(copied);
  };
  /** The Class's own function in the selection: the primary one, else the only one. */
  const selectedFunctionId = (): string | undefined => {
    const own = selectionIds.filter((id) => {
      const row = rowById.get(id);
      return row?.kind === "function" && !row.inherited;
    });
    return selectedId && own.includes(selectedId) ? selectedId : own.length === 1 ? own[0] : undefined;
  };
  const pasteMembers = () => {
    const copied = sessionState.readCopiedClassMembers();
    if (!graph || !copied) return;
    const result = pasteClassMembers({
      graph,
      clipboard: copied,
      classId,
      takenNames: { variable: namesOfKind("variable"), function: namesOfKind("function") },
      ancestors: classAncestorGraphs({
        parentClass: membersOptions?.parentClass,
        parentOf: membersOptions?.parentOf,
        parentGraphs: membersOptions?.parentGraphs,
      }),
      eventOptions: membersOptions,
      // Local variables go into the selected function, else the one whose graph is open.
      targetFunctionId: selectedFunctionId() ?? activeFunctionId,
    });
    showNotice(skippedMembersNotice(result.skipped));
    const last = result.pasted[result.pasted.length - 1];
    if (!last) return;
    onGraphChange(result.graph);
    // The copies become the selection, so they can be dragged or copied on.
    const ids = result.pasted.map((entry) => entry.id);
    anchor.current = last.id;
    setMulti(ids.length > 1 ? { primary: last.id, ids } : null);
    if (last.kind === "event") {
      onFocusEventNode?.(last.id, last.name);
      return;
    }
    onSelectMember?.(last.id, {
      kind: last.kind,
      name: last.name,
      detail: last.id,
      ...(last.componentId ? { componentId: last.componentId } : {}),
      ...(last.functionId ? { functionId: last.functionId } : {}),
    });
  };
  const deleteMembers = (ids: readonly string[]) => {
    if (!graph) return;
    onGraphChange(
      ids.reduce(
        (next, id) => removeClassMember(next, id, { ...membersOptions, classId }),
        graph,
      ),
    );
    setMulti(null);
  };
  const canDelete = (ids: readonly string[]) =>
    ids.every((id) => {
      const member = rowById.get(id);
      return Boolean(member && !member.inherited && !member.componentId);
    });

  const pasteItem = (): ContextMenuItem => ({
    id: "paste",
    label: "Paste",
    shortcut: keybinds.get("edit.paste")?.[0],
    disabled: !graph || !sessionState.hasCopiedClassMembers(),
    testId: "class-menu-paste",
    onSelect: pasteMembers,
  });
  /** **Add Watch** / **Remove Watch** for a variable of the Class's objects (not a function's local or a component's). */
  const watchItem = (member: MyClassMember | undefined): ContextMenuItem[] => {
    if (!watchStore || !classPath || member?.kind !== "variable" || member.functionId || member.componentId) return [];
    const entry = { kind: "variable" as const, assetGuid: classPath, name: member.name, label: { className: classId ?? classPath } };
    return watchStore.has(entry)
      ? [{ id: "remove-watch", label: "Remove Watch", onSelect: () => watchStore.remove(entry) }]
      : [{ id: "add-watch", label: "Add Watch", onSelect: () => watchStore.add(entry) }];
  };
  /**
   * The menu of an entry acts on the group when the entry is part of one, on
   * the entry alone otherwise. `previous` is the selection a long-press or
   * right-click on an unselected entry replaced: Select adds that entry back.
   */
  const entryMenuItems = (
    id: string,
    targets: readonly string[],
    previous: readonly string[],
  ): ContextMenuItem[] => {
    const member = rowById.get(id);
    const single = targets.length === 1;
    return [
      ...(single && member?.kind === "variable"
        ? [
            { id: "get", label: "Get", onSelect: () => spawnAccess("get", id) },
            ...(member.componentId
              ? []
              : [{ id: "set", label: "Set", onSelect: () => spawnAccess("set", id) }]),
          ]
        : []),
      ...(targets.length > 1
        ? [
            {
              id: "deselect",
              label: "Deselect",
              testId: "class-menu-deselect",
              onSelect: () => {
                const rest = targets.filter((entry) => entry !== id);
                chooseEntries(rest, rest[rest.length - 1] ?? null, false);
              },
            },
          ]
        : previous.length > 0
          ? [
              {
                id: "select",
                label: "Select",
                testId: "class-menu-select",
                onSelect: () => chooseEntries([...previous, id], id, true),
              },
            ]
          : []),
      ...(single && renamableIds.has(id)
        ? [{ id: "rename", label: "Rename", onSelect: () => startRename(id) }]
        : []),
      ...(single ? watchItem(member) : []),
      ...(canCopy(targets)
        ? [
            {
              id: "copy",
              label: "Copy",
              shortcut: keybinds.get("edit.copy")?.[0],
              testId: "class-menu-copy",
              onSelect: () => copyMembers(targets),
            },
          ]
        : []),
      pasteItem(),
      ...(canDelete(targets)
        ? [
            {
              id: "delete",
              label: "Delete",
              testId: "class-menu-delete",
              onSelect: () => deleteMembers(targets),
            },
          ]
        : []),
      ...(single && member?.inherited && member.inheritedFrom
        ? [
            {
              id: "open-parent",
              label: "Open Parent Class",
              onSelect: () => onOpenInherited?.(member),
            },
          ]
        : []),
    ];
  };

  // The tree background and the section and folder rows only paste.
  const { menu, closeMenu, openMenuAt, bind: backgroundMenu } = useContextMenu({
    items: () => [pasteItem()],
  });
  const onBackground = (event: { target: EventTarget | null }) =>
    !(event.target instanceof Element && event.target.closest('[role="treeitem"]'));

  const treeKeys = { focusWithinRef: treeRef };
  useKeybindCommand("edit.copy", () => copyMembers(selectionIds), {
    ...treeKeys,
    enabled: () => canCopy(selectionIds),
  });
  useKeybindCommand("edit.paste", pasteMembers, {
    ...treeKeys,
    enabled: () => Boolean(graph) && sessionState.hasCopiedClassMembers(),
  });

  const dragIdsOf = (id: string) =>
    selectionIds.includes(id) ? inTreeOrder(selectionIds) : [id];

  const accessVariables = accessDrop
    ? accessDrop.memberIds.flatMap((id) => {
        const row = rowById.get(id);
        return graph && row?.kind === "variable"
          ? [dropVariableBinding(graph, dropRowOf(row))]
          : [];
      })
    : [];

  return (
    <>
      <div
        ref={treeRef}
        className="h-full min-h-0"
        onContextMenu={(event) => {
          if (onBackground(event)) backgroundMenu.onContextMenu(event);
        }}
        onPointerDown={(event) => {
          if (onBackground(event)) backgroundMenu.onPointerDown(event);
        }}
        onPointerMove={backgroundMenu.onPointerMove}
        onPointerUp={backgroundMenu.onPointerUp}
        onPointerCancel={backgroundMenu.onPointerCancel}
      >
        <TreeView
          rowHeight={touchSizing ? 44 : undefined}
          nodes={nodes}
          selectedId={selectedId}
          selectedIds={selectionIds}
          renamingId={renamingId}
          onRenameRequest={startRename}
          onRenameDone={finishRename}
          onSelect={selectEntry}
          onToggleExpanded={(id) => {
            const sectionId = id.replace(/^section-/, "");
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(sectionId)) next.delete(sectionId);
              else next.add(sectionId);
              return next;
            });
          }}
          onContextMenu={(id, x, y) => {
            if (!rowById.has(id)) {
              openMenuAt(x, y, [pasteItem()]);
              return;
            }
            // Holding or right-clicking an unselected entry replaces the
            // selection; on a selected one the menu acts on the whole group.
            const inGroup = selectionIds.includes(id);
            const targets = inGroup ? inTreeOrder(selectionIds.filter((entry) => rowById.has(entry))) : [id];
            const previous = inGroup ? [] : selectionIds.filter((entry) => rowById.has(entry));
            if (inGroup) {
              if (targets.length === 1) onSelectMember?.(id, rowById.get(id));
            } else {
              chooseEntries([id], id, true);
            }
            openMenuAt(x, y, entryMenuItems(id, targets, previous));
          }}
          onExternalDrop={(id, clientX, clientY) => dropMembers(dragIdsOf(id), clientX, clientY)}
          onExternalDragMove={(id, clientX, clientY) => {
            const allowed = Boolean(canvasDropApi?.containsClientPoint(clientX, clientY));
            const count = dragIdsOf(id).filter((entry) => {
              const row = rowById.get(entry);
              return row && canDropClassMember(row);
            }).length;
            setDropHint({
              clientX,
              clientY,
              allowed,
              ...(allowed && count > 1 ? { label: `Add ${count} Nodes` } : {}),
            });
          }}
          onExternalDragEnd={() => setDropHint(null)}
          onActivate={(id) => {
            const member = rowById.get(id);
            if (!member) return;
            if (member.inherited) {
              onOpenInherited?.(member);
              return;
            }
            onSelectMember?.(id, member);
          }}
          emptyLabel="No class members"
          data-testid="my-blueprint-tree"
        />
      </div>
      <GraphDropHint hint={dropHint} />
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      {notice === null ? null : (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex justify-center">
          <Alert role="status" className="w-auto max-w-sm shadow-md" data-testid="class-notice">
            <AlertDescription>{notice.message}</AlertDescription>
          </Alert>
        </div>
      )}
      <MemberAccessChooser
        open={accessDrop !== null}
        memberName={
          accessDrop && accessDrop.memberIds.length > 1
            ? `${accessDrop.memberIds.length} Members`
            : (accessVariables[0]?.name ?? "Variable")
        }
        variableCount={accessVariables.length}
        showValidatedGet={accessVariables.some((variable) =>
          isObjectInstanceVariableType(variable.typeId, variable.container),
        )}
        showSet={accessVariables.some((variable) => !variable.componentId)}
        onOpenChange={(open) => {
          if (!open) setAccessDrop(null);
        }}
        onChoose={chooseAccess}
      />
      <NamePromptDialog
        open={memberPromptKind !== null}
        onOpenChange={(open) => {
          if (!open) setMemberPromptKind(null);
        }}
        title={
          memberPromptKind
            ? memberNamePromptCopy(memberPromptKind, {
                local: memberPromptLocal,
              }).title
            : "Add Member"
        }
        label={
          memberPromptKind
            ? memberNamePromptCopy(memberPromptKind, {
                local: memberPromptLocal,
              }).label
            : "Name"
        }
        onSubmit={(name) => {
          if (!graph || !memberPromptKind) return;
          const extras =
            memberPromptLocal && activeFunctionId
              ? { functionId: activeFunctionId }
              : undefined;
          const next = addClassMember(
            graph,
            memberPromptKind,
            name,
            undefined,
            extras,
          );
          onGraphChange(next);
          if (memberPromptKind === "event") {
            const node = next.nodes[next.nodes.length - 1];
            if (node) {
              onFocusEventNode?.(node.id, node.data.name as string);
            }
            return;
          }
          const added = next.members?.[next.members.length - 1];
          if (added) {
            onSelectMember?.(added.id, {
              kind: added.kind,
              name: added.name,
              detail: added.id,
              typeId: added.typeId,
            });
          }
        }}
      />
      <AssetPicker
        open={interfacePickerOpen}
        onOpenChange={setInterfacePickerOpen}
        assets={interfaceAssets ?? []}
        allowedTypes={["ScriptInterface"]}
        allowNone={false}
        title="Pick Script Interface"
        onPick={(guid) => {
          if (!graph || !guid) return;
          const named =
            (interfaceAssets ?? []).find((asset) => asset.guid === guid)?.name ??
            "Interface";
          const next = addClassMember(graph, "interface", named, undefined, {
            assetGuid: guid,
          });
          onGraphChange(next);
          const added = next.members?.[next.members.length - 1];
          if (added) {
            onSelectMember?.(added.id, {
              kind: added.kind,
              name: added.name,
              detail: added.id,
            });
          }
        }}
        data-testid="class-interface-picker"
      />
    </>
  );
}

/** Class panel — My Blueprint member tree stacked under Components. */
export function MyClassPanel(props: MyClassPanelProps) {
  const dockApi = props.containerApi as MyClassPanelProps["containerApi"] | undefined;
  const { documentId } = useDocumentWorkspace();
  const { applyGraphChange, applyAssetDocumentChange, openDocument } =
    useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const interfaceDocuments = useOpenDocumentsOfKinds(INTERFACE_KINDS);
  const { setFocusDiagnostic } = useValidation();
  const {
    selectedMemberId,
    selectedNodeIds,
    canvasDropApi,
    setSelectedMemberId,
    setSelectedNodeIds,
    activeFunctionId,
    setActiveFunctionId,
  } = useGraphEditing();
  const selectedId = selectedMemberId ?? selectedNodeIds[0] ?? null;

  const doc = useOpenDocument(documentId);
  const graph =
    serializedGraphFromDocument(doc?.ref.kind ?? "", doc?.content) ??
    (doc ? { nodes: [], edges: [] } : null);
  const persistGraph = (next: SerializedGraph) => {
    if (!doc) return;
    const commit = commitLogicGraph(doc.ref.kind, doc.content, next);
    if (commit.kind !== "graph") {
      void applyAssetDocumentChange(documentId, commit.payload, commit.mergeKey);
      return;
    }
    void applyGraphChange(documentId, commit.graph);
  };
  const className = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : null;
  const docPath = doc?.ref.path;
  // Registry-only views follow the registry epoch, not edits of this Class.
  const { interfaceAssets, indexed, parentOf } = useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    return {
      interfaceAssets: assets
        .filter((asset) => asset.header.type === "ScriptInterface")
        .map((asset) => ({
          guid: asset.header.guid,
          name: asset.header.name,
          type: asset.header.type,
        })),
      indexed: assets.find((asset) => asset.path === docPath),
      parentOf: classParentLookup(assets),
    };
  }, [assetRegistry, docPath, registryEpoch]);
  // Parent graphs and interfaces also read open (unsaved) documents.
  const membersOptions = useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    return {
      classId: className ?? undefined,
      parentClass: indexed?.header.parentClass ?? null,
      parentOf,
      parentGraphs: collectClassGraphsForPalette({
        assets,
        openDocuments: classDocuments,
        classIdForPath: classIdForGraphPath,
      }),
      assetType: indexed?.header.type,
      scriptInterfaces: collectScriptInterfacesForPalette({
        assets,
        openDocuments: interfaceDocuments,
      }),
    };
  }, [assetRegistry, className, classDocuments, indexed, interfaceDocuments, parentOf, registryEpoch]);

  const focusEvent = (nodeId: string, name: string) => {
    dockApi?.getPanel(EVENT_GRAPH_PANEL_ID)?.api.setActive();
    setActiveFunctionId(null);
    setSelectedNodeIds([nodeId]);
    setFocusDiagnostic({
      severity: "info",
      code: "my-blueprint",
      message: name,
      assetGuid: doc?.ref.path ?? documentId,
      graphId: documentId,
      nodeId,
    });
  };

  return (
    <PanelFrame data-testid="my-class-panel">
      <div className="flex h-full min-h-0 flex-col">
      {className ? (
        <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">
          {className}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
      <ClassMembersView
        graph={graph}
        selectedId={selectedId}
        activeFunctionId={activeFunctionId}
        classId={className ?? undefined}
        classPath={docPath}
        canvasDropApi={canvasDropApi}
        interfaceAssets={interfaceAssets}
        membersOptions={membersOptions}
        onGraphChange={persistGraph}
        onFocusEventNode={focusEvent}
        onOpenInherited={(member) => {
          const from = member.inheritedFrom;
          if (!from || isLockedEngineClassId(from)) return;
          const asset = (assetRegistry?.list() ?? []).find((entry) => {
            if (entry.header.type !== "Class") return false;
            return classIdForGraphPath(entry.path) === from;
          });
          if (!asset) return;
          void openDocument({
            kind: "graph",
            path: asset.path,
            label: asset.header.name,
          });
        }}
        onSelectMember={(id, member) => {
          if (!id) {
            setSelectedMemberId(null);
            return;
          }
          if (member?.inherited) {
            setSelectedMemberId(id);
            setSelectedNodeIds([]);
            return;
          }
          if (member?.kind === "function") {
            setSelectedMemberId(id);
            if (dockApi) openFunctionGraphPanel(dockApi, id, member.name);
            setActiveFunctionId(id);
            return;
          }
          if (member?.kind === "event") {
            const eventType = member.eventType ?? "flow.event.custom";
            const existing =
              graph?.nodes.find((node) => node.id === member.detail) ??
              graph?.nodes.find((node) => {
                if (node.type !== eventType) return false;
                if (eventType !== "flow.event.custom") return true;
                return eventMemberBodyName(node) === member.name;
              });
            if (existing) {
              focusEvent(existing.id, member.name);
              return;
            }
            if (isFlowEventCallNode(eventType) || !graph) return;
            const next = ensureEventNodeOnGraph(graph, eventType, {
              name:
                eventType === "flow.event.custom"
                  ? formatEventMemberName(member.name)
                  : undefined,
              title:
                eventType === "flow.event.custom"
                  ? formatEventTitle(member.name)
                  : member.name,
              parentClassId: membersOptions?.parentClass,
              pins: member.pins,
            });
            persistGraph(next);
            const spawned = next.nodes.find((node) => {
              if (node.type !== eventType) return false;
              if (eventType !== "flow.event.custom") return true;
              return eventMemberBodyName(node) === formatEventMemberName(member.name);
            });
            if (spawned) focusEvent(spawned.id, member.name);
            return;
          }
          setSelectedMemberId(id);
        }}
      />
      </div>
      </div>
    </PanelFrame>
  );
}
