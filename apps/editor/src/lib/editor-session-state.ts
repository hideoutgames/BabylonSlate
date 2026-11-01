import type { SerializedActor, SerializedTimelineClip } from "@haptic/core";
import type { EditorCameraSessionState } from "@haptic/render";
import type { ClassMemberClipboard } from "./class-member-clipboard";
import type { CopiedTimelineKeys } from "./timeline-track-edits";
import { moveKeyedEntry } from "./move-keyed-entry";
import type { ParticleModuleId } from "./particle-value-modes";

export type GraphSessionViewport = { x: number; y: number; zoom: number };

/**
 * Editor state for one project session, keyed by document id: editor
 * camera poses, graph pan/zoom per surface and particle module cards the
 * user closed, plus the clipboards of the Outliner (actors), the Class tree
 * (members), the Clips window (Timeline Clips) and the Timeline window (keys), which outlive the document they were copied from. It is deliberately non-reactive: callers read it when they
 * mount or render and write it without notifying anyone, so saving a camera
 * pose or a pan never re-renders the editor. Closing a tab keeps its entries
 * (reopening a Scene restores its view); a new project session starts empty.
 */
export class EditorSessionState {
  private actorClipboard: { overlay: boolean; actors: SerializedActor[] } | null = null;
  private classMemberClipboard: ClassMemberClipboard | null = null;
  private timelineClipClipboard: SerializedTimelineClip[] | null = null;
  private timelineKeyClipboard: CopiedTimelineKeys | null = null;

  copyActors(actors: SerializedActor[], overlay: boolean): void {
    this.actorClipboard = { actors: structuredClone(actors), overlay };
  }

  hasCopiedActors(overlay: boolean): boolean {
    return this.actorClipboard?.overlay === overlay && this.actorClipboard.actors.length > 0;
  }

  readCopiedActors(overlay: boolean): SerializedActor[] {
    return this.actorClipboard?.overlay === overlay
      ? structuredClone(this.actorClipboard.actors)
      : [];
  }

  copyTimelineClips(clips: readonly SerializedTimelineClip[]): void {
    this.timelineClipClipboard = structuredClone([...clips]);
  }

  hasCopiedTimelineClips(): boolean {
    return (this.timelineClipClipboard?.length ?? 0) > 0;
  }

  readCopiedTimelineClips(): SerializedTimelineClip[] {
    return this.timelineClipClipboard ? structuredClone(this.timelineClipClipboard) : [];
  }

  copyTimelineKeys(keys: CopiedTimelineKeys): void {
    this.timelineKeyClipboard = structuredClone(keys);
  }

  readCopiedTimelineKeys(): CopiedTimelineKeys | null {
    return this.timelineKeyClipboard ? structuredClone(this.timelineKeyClipboard) : null;
  }

  copyClassMembers(members: ClassMemberClipboard): void {
    this.classMemberClipboard = structuredClone(members);
  }

  hasCopiedClassMembers(): boolean {
    const copied = this.classMemberClipboard;
    return Boolean(copied && copied.variables.length + copied.functions.length + copied.events.length > 0);
  }

  readCopiedClassMembers(): ClassMemberClipboard | null {
    return this.classMemberClipboard ? structuredClone(this.classMemberClipboard) : null;
  }

  private readonly cameraPoses = new Map<string, EditorCameraSessionState>();
  private readonly graphViewports = new Map<string, Map<string, GraphSessionViewport>>();
  private readonly closedModules = new Map<string, ReadonlySet<ParticleModuleId>>();
  /**
   * Renamed id → current id. A workspace mounted under the old id unmounts
   * after the rename and saves its camera on the way out; that write lands on
   * the new id instead of resurrecting state under the old one.
   */
  private readonly forwards = new Map<string, string>();

  private writeId(documentId: string): string {
    return this.forwards.get(documentId) ?? documentId;
  }

  loadCameraPose(documentId: string): EditorCameraSessionState | null {
    return this.cameraPoses.get(documentId) ?? null;
  }

  saveCameraPose(
    documentId: string,
    pose: EditorCameraSessionState | null | undefined,
  ): void {
    const id = this.writeId(documentId);
    if (pose) this.cameraPoses.set(id, pose);
    else this.cameraPoses.delete(id);
  }

  loadGraphViewport(
    documentId: string,
    surface: string,
  ): GraphSessionViewport | null {
    return this.graphViewports.get(documentId)?.get(surface) ?? null;
  }

  saveGraphViewport(
    documentId: string,
    surface: string,
    viewport: GraphSessionViewport,
  ): void {
    const id = this.writeId(documentId);
    let surfaces = this.graphViewports.get(id);
    if (!surfaces) {
      surfaces = new Map();
      this.graphViewports.set(id, surfaces);
    }
    surfaces.set(surface, viewport);
  }

  loadClosedModules(documentId: string): ReadonlySet<ParticleModuleId> | null {
    return this.closedModules.get(documentId) ?? null;
  }

  saveClosedModules(
    documentId: string,
    closed: ReadonlySet<ParticleModuleId>,
  ): void {
    this.closedModules.set(this.writeId(documentId), closed);
  }

  /**
   * A renamed or moved document keeps its view state under the new id.
   * Anything already under `newId` described another asset and is dropped.
   * Late writes under `oldId` forward to `newId` until a document opens at
   * `oldId` again.
   */
  rekeyDocument(oldId: string, newId: string): void {
    if (oldId === newId) return;
    moveKeyedEntry(this.cameraPoses, oldId, newId);
    moveKeyedEntry(this.graphViewports, oldId, newId);
    moveKeyedEntry(this.closedModules, oldId, newId);
    this.forwards.delete(newId);
    for (const [from, to] of this.forwards) {
      if (to === oldId) this.forwards.set(from, newId);
    }
    this.forwards.set(oldId, newId);
  }

  /** A document opened at `id` owns that id again: stop forwarding its writes. */
  documentOpened(id: string): void {
    this.forwards.delete(id);
  }
}
