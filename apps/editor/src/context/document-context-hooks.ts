import { createContext, useContext, useSyncExternalStore, type Context } from "react";
import type { DocumentKind } from "@haptic/core";
import type { OpenDocument } from "../services/document-service";
import type { DocumentSubscriptions } from "./document-subscriptions";
import type {
  ActiveDocumentState,
  AppRoute,
  CompileState,
  DocumentActions,
  EditorShellState,
  ProjectState,
  RegistryState,
  SaveState,
  SourceControlState,
} from "./document-context-types";

// The contexts `DocumentProvider` fills, and the hooks that read them.

/** Created once per provider: action-only consumers never re-render through it. */
export const DocumentActionsContext = createContext<DocumentActions | null>(null);
/** Changes only when the app moves between Homepage and the editor. */
export const AppRouteContext = createContext<AppRoute | null>(null);
/** Created once per provider; the per-document hooks read the service through it. */
export const DocumentSubscriptionsContext = createContext<DocumentSubscriptions | null>(null);
export const ProjectStateContext = createContext<ProjectState | null>(null);
export const RegistryStateContext = createContext<RegistryState | null>(null);
export const ActiveDocumentStateContext = createContext<ActiveDocumentState | null>(null);
export const SaveStateContext = createContext<SaveState | null>(null);
export const CompileStateContext = createContext<CompileState | null>(null);
export const EditorShellStateContext = createContext<EditorShellState | null>(null);
/** Replaced on every thumbnail write, so only views that show thumbnails read it. */
export const ThumbnailVersionsContext = createContext<Readonly<Record<string, number>> | null>(null);
export const SourceControlStateContext = createContext<SourceControlState | null>(null);

/** Bumps only the Windows menu so dock add/remove does not remount editor chrome. */
export const DockWindowTickContext = createContext(0);

/**
 * The document callbacks only. The object and each callback keep their
 * identity while the provider is mounted, so a component that only acts on
 * documents does not re-render when they change; each callback reads the
 * current documents, project and Anim modes when it runs.
 */
export function useDocumentActions(): DocumentActions {
  const actions = useContext(DocumentActionsContext);
  if (!actions) {
    throw new Error("useDocumentActions must be used within DocumentProvider");
  }
  return actions;
}

/** Homepage or editor; its callers re-render only when the route changes. */
export function useAppRoute(): AppRoute {
  const route = useContext(AppRouteContext);
  if (route === null) {
    throw new Error("useAppRoute must be used within DocumentProvider");
  }
  return route;
}

export function useDockWindowTick(): number {
  return useContext(DockWindowTickContext);
}

function useSlice<T>(context: Context<T | null>, name: string): T {
  const value = useContext(context);
  if (value === null) {
    throw new Error(`${name} must be used within DocumentProvider`);
  }
  return value;
}

/** `projectDocument` and `projectName`; changes when the project document does. */
export function useProjectState(): ProjectState {
  return useSlice(ProjectStateContext, "useProjectState");
}

/**
 * `assetRegistry`, `registryEpoch` and the registry-adjacent project state
 * (GUID, extensions, plugins, Show Plugin Content, search index). Changes
 * when `registryEpoch` advances, never on document edits or tab changes, so
 * reading the registry while rendering stays current.
 */
export function useRegistryState(): RegistryState {
  return useSlice(RegistryStateContext, "useRegistryState");
}

/** The active tab with its Anim / Scene mode, Focus and Undo / Redo state. */
export function useActiveDocumentState(): ActiveDocumentState {
  return useSlice(ActiveDocumentStateContext, "useActiveDocumentState");
}

/** Dirty documents (stable while the dirty set is), project dirty and Auto-Save. */
export function useSaveState(): SaveState {
  return useSlice(SaveStateContext, "useSaveState");
}

/** Compile staleness: whether open graphs changed since the last Compile, and their signature. */
export function useCompileState(): CompileState {
  return useSlice(CompileStateContext, "useCompileState");
}

/** Homepage lists, recovery, migration and exclusive Scene prompts, the Thumbnails setting. */
export function useEditorShellState(): EditorShellState {
  return useSlice(EditorShellStateContext, "useEditorShellState");
}

/**
 * Each asset's thumbnail version, bumped when its thumbnail is written or its
 * saved revision changes; key thumbnail reloads on it. A new record on every
 * write, so the shell slice and its readers stay still while thumbnails are
 * captured.
 */
export function useThumbnailVersions(): Readonly<Record<string, number>> {
  return useSlice(ThumbnailVersionsContext, "useThumbnailVersions");
}

/** The source control service; a new object whenever its state changes. */
export function useSourceControl(): SourceControlState {
  return useSlice(SourceControlStateContext, "useSourceControl");
}

/** The active tab's id. Re-renders only when another tab becomes active. */
export function useActiveDocumentId(): string | null {
  const subscriptions = useSlice(DocumentSubscriptionsContext, "useActiveDocumentId");
  return useSyncExternalStore(subscriptions.subscribe, subscriptions.activeDocumentId);
}

/** Tab ids in order; re-renders only when a tab opens, closes or moves. */
export function useTabOrder(): readonly string[] {
  const subscriptions = useSlice(DocumentSubscriptionsContext, "useTabOrder");
  return useSyncExternalStore(subscriptions.subscribe, subscriptions.tabOrderSnapshot);
}

/**
 * Open documents in tab order, for tab strips and lists of open documents.
 * Re-renders when a document opens, closes, moves or changes its label,
 * layout, dirty state or background flag; content edits do not. Read
 * content through `useOpenDocument`.
 */
export function useOpenDocumentTabs(): OpenDocument[] {
  const subscriptions = useSlice(DocumentSubscriptionsContext, "useOpenDocumentTabs");
  return useSyncExternalStore(subscriptions.subscribe, subscriptions.tabsSnapshot);
}

/**
 * One open document: the same entry `getOpenDocuments()` holds. Re-renders when
 * that document opens, closes or changes its content, label, layout or dirty
 * state; edits of other documents and tab switches do not. The entry is
 * mutated in place, so key memos on `document.content`, not on the entry.
 */
export function useOpenDocument(id: string | null | undefined): OpenDocument | undefined {
  const subscriptions = useSlice(DocumentSubscriptionsContext, "useOpenDocument");
  const key = useSyncExternalStore(subscriptions.subscribe, () =>
    id ? subscriptions.documentKey(id) : undefined,
  );
  return key?.document;
}

/** Whether one open document has unsaved edits; false when it is not open. */
export function useDocumentDirty(id: string | null | undefined): boolean {
  const subscriptions = useSlice(DocumentSubscriptionsContext, "useDocumentDirty");
  return useSyncExternalStore(subscriptions.subscribe, () =>
    id ? subscriptions.dirty(id) : false,
  );
}

/**
 * `documentKindsRevision` for `kinds`: changes exactly when a document of one
 * of them changes. Key memos that read those documents on it.
 */
export function useDocumentKindsRevision(kinds: readonly DocumentKind[]): number {
  const subscriptions = useSlice(DocumentSubscriptionsContext, "useDocumentKindsRevision");
  return useSyncExternalStore(subscriptions.subscribe, () => subscriptions.kindsRevision(kinds));
}
