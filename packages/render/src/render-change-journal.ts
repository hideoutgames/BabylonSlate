import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";

/**
 * What changed about a node, as bits of one number (`noteRenderChange`, `RenderChangeReader.drain`). Not where a map's
 * content changed: that is the shadow map pass journal (`shadow-change-journal.ts`).
 */
export const RenderChange = {
  /** Its world matrix was recomputed or replaced (`_afterComputeWorldMatrix`, `freezeWorldMatrix(matrix)`). */
  Transform: 1,
  /** `isVisible`, `inheritVisibility` or `visibility` changed, its own or (inherited) an ancestor's. */
  Visibility: 2,
  /** Its own or an ancestor's enabled state was set, or it was re-parented (`_syncParentEnabledState`). */
  Enabled: 4,
  /** Its Material was replaced (`_setMaterial`). */
  Material: 8,
  /** Its geometry was replaced or notified an update (`applyToMesh`, `releaseForMesh`, `_notifyUpdate`). */
  Geometry: 16,
  /** Haptic-owned state with no Babylon write point (`noteRenderChange`). */
  Other: 32,
} as const;

/** Entries kept for the slowest reader; one further behind starts over (`drain` returns false). */
const MAX_ENTRIES = 1 << 16;

type JournalScene = Scene & { _hapticRenderChanges?: Journal };
/** What the hooks read of a node or geometry beyond its public API (Babylon 9.29 internals). */
type Internals = {
  _scene?: JournalScene;
  _children?: Node[] | null;
  _nodeDataStorage: { _isVisible: boolean };
  _meshes: AbstractMesh[];
  instances?: AbstractMesh[];
};

function internals(target: object): Internals {
  return target as unknown as Internals;
}

/** The journal of the Scene `target` (a node or geometry) belongs to, while that Scene has a reader. */
function journalOf(target: object): Journal | undefined {
  return internals(target)._scene?._hapticRenderChanges;
}

/**
 * One Scene's change log: each change appends the node once until every reader has read it (a later change of an
 * entry no reader has reached yet joins that entry). Readers keep their own cursors; entries all have read are dropped.
 */
class Journal {
  readonly nodes: Node[] = [];
  readonly kinds: number[] = [];
  /** The absolute position of `nodes[0]`. */
  base = 0;
  /** Each node's last entry, absolute. */
  readonly last = new Map<Node, number>();
  readonly readers = new Set<Reader>();
  /** The furthest reader cursor: an entry at or after it is unread by every reader. */
  frontier = 0;

  get end(): number {
    return this.base + this.nodes.length;
  }

  note(node: Node, kind: number): void {
    const at = this.last.get(node);
    if (at !== undefined && at >= this.frontier) {
      const index = at - this.base;
      this.kinds[index] = this.kinds[index]! | kind;
      return;
    }
    if (this.nodes.length >= MAX_ENTRIES) {
      for (const reader of this.readers) reader.overflowed = true;
      this.clear();
    }
    this.last.set(node, this.end);
    this.nodes.push(node);
    this.kinds.push(kind);
  }

  clear(): void {
    this.base = this.end;
    this.frontier = this.base;
    this.nodes.length = 0;
    this.kinds.length = 0;
    this.last.clear();
  }

  /** After a reader moved: drops what every reader has read. */
  settle(): void {
    let lowest = Infinity, highest = this.base;
    for (const reader of this.readers) {
      lowest = Math.min(lowest, reader.cursor);
      highest = Math.max(highest, reader.cursor);
    }
    this.frontier = highest;
    if (lowest >= this.end) this.clear();
  }
}

/** One consumer's position in a Scene's change log (`openRenderChangeReader`). */
export interface RenderChangeReader {
  /**
   * Visits every node changed since the last drain, once, with the kinds of change (`RenderChange` bits) it saw. False
   * (visiting none) when the reader fell too far behind and lost some: it must read the state it follows in full.
   */
  drain(visit: (node: Node, kinds: number) => void): boolean;
  dispose(): void;
}

class Reader implements RenderChangeReader {
  cursor: number;
  overflowed = false;
  private readonly scene: JournalScene;
  private readonly journal: Journal;

  constructor(scene: JournalScene, journal: Journal) {
    this.scene = scene;
    this.journal = journal;
    this.cursor = journal.end;
  }

  drain(visit: (node: Node, kinds: number) => void): boolean {
    const journal = this.journal;
    if (this.overflowed) {
      this.overflowed = false;
      this.cursor = journal.end;
      journal.settle();
      return false;
    }
    // Read the length each time: a visit may note further changes, which this drain then also reads.
    for (let at = this.cursor - journal.base; at < journal.nodes.length; at++) visit(journal.nodes[at]!, journal.kinds[at]!);
    this.cursor = journal.end;
    journal.settle();
    return true;
  }

  dispose(): void {
    const journal = this.journal;
    if (!journal.readers.delete(this)) return;
    if (journal.readers.size === 0) {
      journal.clear();
      if (this.scene._hapticRenderChanges === journal) delete this.scene._hapticRenderChanges;
    } else journal.settle();
  }
}

/**
 * Opens a reader of `scene`'s visual changes. The Scene records changes only while it has a reader: without one each
 * hooked Babylon write costs one field read.
 */
export function openRenderChangeReader(scene: Scene): RenderChangeReader {
  install();
  const target = scene as JournalScene;
  let journal = target._hapticRenderChanges;
  if (!journal) {
    journal = target._hapticRenderChanges = new Journal();
    const owned = journal;
    scene.onDisposeObservable.addOnce(() => {
      owned.readers.clear();
      owned.clear();
      if (target._hapticRenderChanges === owned) delete target._hapticRenderChanges;
    });
  }
  const reader = new Reader(target, journal);
  journal.readers.add(reader);
  journal.frontier = journal.end;
  return reader;
}

/** Records a change of Haptic-owned state that no Babylon write reaches (`RenderChange.Other` unless `kinds` says). */
export function noteRenderChange(node: Node, kinds: number = RenderChange.Other): void {
  journalOf(node)?.note(node, kinds);
}

let verifying = false;

/**
 * Debugging aid: each frame a journal reader's walk is followed by the full scan it replaces, which must find nothing
 * more (`RenderDiagnostics.rendererWork.shadowJournal.mismatches`).
 */
export function verifyRenderChangeJournal(enabled: boolean): void {
  verifying = enabled;
}

export function verifiesRenderChangeJournal(): boolean {
  return verifying;
}

function noteMesh(journal: Journal, mesh: AbstractMesh, kind: number): void {
  journal.note(mesh, kind);
  // An instance reads its source's Material, visibility and geometry through getters.
  const instances = internals(mesh).instances;
  if (instances) for (const instance of instances) journal.note(instance, kind);
}

/** Descendants whose `isVisible` reads `node`'s: those that inherit visibility all the way up to it. */
function noteInheritors(journal: Journal, node: Node): void {
  const children = internals(node)._children;
  if (!children) return;
  for (const child of children) {
    if (!child.inheritVisibility) continue;
    journal.note(child, RenderChange.Visibility);
    noteInheritors(journal, child);
  }
}

/** The property names whose Babylon writes the journal hooks, on the prototypes it hooks them on. */
const HOOKED_NAMES = ["isVisible", "inheritVisibility", "visibility", "material", "_setMaterial", "_syncParentEnabledState", "_afterComputeWorldMatrix"];

const hookedPrototypes = new Set<object>();
const followedPrototypes = new WeakMap<object, boolean>();

/**
 * Whether the journal hears every visibility, enabled and Material write of `node`: false when its class (beyond
 * Babylon's Node, TransformNode, AbstractMesh, Mesh and InstancedMesh, whose writes it hooks) or the object itself
 * redefines one of them (a Gaussian splat part proxy's `isVisible`, a line mesh's `material`). A reader polls such a
 * node instead.
 */
export function journalFollows(node: Node): boolean {
  install();
  for (const name of HOOKED_NAMES) if (Object.prototype.hasOwnProperty.call(node, name)) return false;
  let prototype = Object.getPrototypeOf(node) as object | null;
  const first = prototype;
  if (!first) return false;
  const known = followedPrototypes.get(first);
  if (known !== undefined) return known;
  let follows = true;
  for (; prototype && !hookedPrototypes.has(prototype); prototype = Object.getPrototypeOf(prototype) as object | null)
    if (HOOKED_NAMES.some((name) => Object.prototype.hasOwnProperty.call(prototype, name))) follows = false;
  if (!prototype) follows = false;
  followedPrototypes.set(first, follows);
  return follows;
}

type Accessor = { get?: () => unknown; set?: (value: unknown) => void };

function accessor(prototype: object, name: string): Accessor & PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (!descriptor?.set) throw new Error(`Babylon 9.29 ${name} accessor not found`);
  return descriptor;
}

let installed = false;

/**
 * Pinned 9.29 adapter, installed once on the first reader: wraps the prototype methods and accessors where Babylon
 * writes what a visual draws, so each write notes its node in its Scene's journal. Prototype wrappers rather than a
 * hunk of the Babylon patch: they need no rebuild of the patched package, they stay out of every Scene without a
 * reader, and the pin review checks them in one place. Each wrapper calls the original first and notes only an actual
 * change where the write can be a no-op.
 */
function install(): void {
  if (installed) return;
  installed = true;
  hookedPrototypes.add(Node.prototype).add(TransformNode.prototype).add(AbstractMesh.prototype).add(Mesh.prototype).add(InstancedMesh.prototype);

  // AbstractMesh's override does not call TransformNode's; Mesh's calls AbstractMesh's.
  type Method = (this: Node, ...args: never[]) => void;
  // AbstractMesh's override does not call TransformNode's; Mesh's calls AbstractMesh's.
  for (const prototype of [TransformNode.prototype, AbstractMesh.prototype] as unknown as Array<{ _afterComputeWorldMatrix: Method }>) {
    const after = prototype._afterComputeWorldMatrix;
    prototype._afterComputeWorldMatrix = function (this: Node) {
      after.call(this);
      journalOf(this)?.note(this, RenderChange.Transform);
    };
  }

  // setEnabled and `parent` both run it, and it recurses into every descendant.
  const nodePrototype = Node.prototype as unknown as { _syncParentEnabledState: Method };
  const sync = nodePrototype._syncParentEnabledState;
  nodePrototype._syncParentEnabledState = function (this: Node) {
    sync.call(this);
    journalOf(this)?.note(this, RenderChange.Enabled | RenderChange.Visibility);
  };

  const visible = accessor(Node.prototype, "isVisible");
  Object.defineProperty(Node.prototype, "isVisible", {
    ...visible,
    set(this: Node, value: boolean) {
      const was = internals(this)._nodeDataStorage._isVisible;
      visible.set!.call(this, value);
      const journal = journalOf(this);
      if (!journal || was === value) return;
      journal.note(this, RenderChange.Visibility);
      noteInheritors(journal, this);
    },
  });
  const inherit = accessor(Node.prototype, "inheritVisibility");
  Object.defineProperty(Node.prototype, "inheritVisibility", {
    ...inherit,
    set(this: Node, value: boolean) {
      const was = this.inheritVisibility;
      inherit.set!.call(this, value);
      const journal = journalOf(this);
      if (!journal || was === value) return;
      journal.note(this, RenderChange.Visibility);
      noteInheritors(journal, this);
    },
  });

  const visibility = accessor(AbstractMesh.prototype, "visibility");
  Object.defineProperty(AbstractMesh.prototype, "visibility", {
    ...visibility,
    set(this: AbstractMesh, value: number) {
      const was = this.visibility;
      visibility.set!.call(this, value);
      const journal = journalOf(this);
      if (journal && !Object.is(was, this.visibility)) noteMesh(journal, this, RenderChange.Visibility);
    },
  });

  // Mesh's `material` setter calls it too.
  const meshPrototype = AbstractMesh.prototype as unknown as { _setMaterial: (this: AbstractMesh, value: unknown) => void };
  const setMaterial = meshPrototype._setMaterial;
  meshPrototype._setMaterial = function (this: AbstractMesh, value: unknown) {
    const was = this.material;
    setMaterial.call(this, value);
    const journal = journalOf(this);
    if (journal && was !== this.material) noteMesh(journal, this, RenderChange.Material);
  };

  type GeometryMethods = {
    _notifyUpdate: (this: Geometry, kind?: string) => void;
    applyToMesh: (this: Geometry, mesh: Mesh) => void;
    releaseForMesh: (this: Geometry, mesh: Mesh, shouldDispose?: boolean) => void;
  };
  const geometryPrototype = Geometry.prototype as unknown as GeometryMethods;
  const notifyUpdate = geometryPrototype._notifyUpdate;
  geometryPrototype._notifyUpdate = function (this: Geometry, kind?: string) {
    notifyUpdate.call(this, kind);
    const journal = journalOf(this);
    if (journal) for (const mesh of internals(this)._meshes) noteMesh(journal, mesh, RenderChange.Geometry);
  };
  const applyToMesh = geometryPrototype.applyToMesh;
  geometryPrototype.applyToMesh = function (this: Geometry, mesh: Mesh) {
    applyToMesh.call(this, mesh);
    const journal = journalOf(mesh);
    if (journal) noteMesh(journal, mesh, RenderChange.Geometry);
  };
  const releaseForMesh = geometryPrototype.releaseForMesh;
  geometryPrototype.releaseForMesh = function (this: Geometry, mesh: Mesh, shouldDispose?: boolean) {
    releaseForMesh.call(this, mesh, shouldDispose);
    const journal = journalOf(mesh);
    if (journal) noteMesh(journal, mesh, RenderChange.Geometry);
  };
}
