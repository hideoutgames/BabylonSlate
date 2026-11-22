import { BoundingBox } from "@babylonjs/core/Culling/boundingBox";
import type { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { BoundingSphere } from "@babylonjs/core/Culling/boundingSphere";
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
  /** Its Material, or its Material for a render pass, was replaced (`_setMaterial`, `setMaterialForRenderPass`). */
  Material: 8,
  /** Its geometry was replaced or notified an update (`applyToMesh`, `releaseForMesh`, `_notifyUpdate`). */
  Geometry: 16,
  /** Haptic-owned state with no Babylon write point (`noteRenderChange`). */
  Other: 32,
  /**
   * An overlay visual's opacity or tint changed (`applyOverlayVisualStyle`): the values it draws with, never its
   * program. A change that crosses full opacity, which changes how it blends, also marks the Scene's readiness.
   */
  Style: 64,
  /**
   * What decides where its draws queue beyond its Material and visibility: its rendering group, layer mask, vertex
   * alpha or LOD levels (`renderingGroupId`, `layerMask`, `hasVertexAlpha`, `addLODLevel`, `removeLODLevel`).
   */
  Dispatch: 128,
  /**
   * Its bounding info was replaced (`setBoundingInfo`, `buildBoundingInfo`), or the world values of the bounding info a
   * reader follows for it (`followBounds`) were written (`BoundingBox._update`, `BoundingSphere._update`, which every
   * `update`, `reConstruct`, `centerOn`, `scale` and `encapsulate` runs). Recorded only for readers that name it: the
   * default set of kinds leaves it out.
   */
  Bounds: 256,
  /**
   * What Babylon's `isReady()` reads of it changed: its ready flag (`_setReady`), its source's (an instance reads it),
   * or the source it draws through (`addInstance`, which an instance pool's re-key also runs), whose `visibility` it
   * reads too. Recorded only for readers that name it.
   */
  Ready: 512,
} as const;

/** Entries kept for the slowest reader; one further behind starts over (`drain` returns false). */
const MAX_ENTRIES = 1 << 16;
/** Entries every reader has read are dropped once there are at least this many and they are half the log. */
const TRIM_ENTRIES = 1024;

type JournalScene = Scene & { _hapticRenderChanges?: Journal };
/** What the hooks read of a node or geometry beyond its public API (Babylon 9.29 internals). */
type Internals = {
  _scene?: JournalScene;
  _children?: Node[] | null;
  _nodeDataStorage: { _isVisible: boolean; _isReady: boolean };
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
  /** The kinds some reader reads; others are not recorded. */
  wanted = 0;

  get end(): number {
    return this.base + this.nodes.length;
  }

  note(node: Node, kinds: number): void {
    const kind = kinds & this.wanted;
    if (!kind) return;
    const at = this.last.get(node);
    if (at !== undefined && at >= this.frontier) {
      const index = at - this.base;
      this.kinds[index] = this.kinds[index]! | kind;
      return;
    }
    if (this.nodes.length >= MAX_ENTRIES) {
      // Only the readers that have not read every entry lose any.
      for (const reader of this.readers) if (reader.cursor < this.end) reader.overflowed = true;
      this.clear();
    }
    this.last.set(node, this.end);
    this.nodes.push(node);
    this.kinds.push(kind);
  }

  clear(): void {
    this.base = this.end;
    this.frontier = this.base;
    // Every drain that every reader has caught up with ends here: an empty journal is left as it is, as clearing a Map
    // makes it a new table.
    if (!this.nodes.length) return;
    this.nodes.length = 0;
    this.kinds.length = 0;
    this.last.clear();
  }

  /** After a reader moved: drops what every reader has read. */
  settle(): void {
    let lowest = Infinity, highest = this.base;
    this.wanted = 0;
    for (const reader of this.readers) {
      lowest = Math.min(lowest, reader.cursor);
      highest = Math.max(highest, reader.cursor);
      this.wanted |= reader.kinds;
    }
    this.frontier = highest;
    if (lowest >= this.end) this.clear();
    // Readers that drain at different points of a frame, with changes noted in between, may never all be caught up at
    // once: what they have all read goes once it is most of the log.
    else if (lowest - this.base >= TRIM_ENTRIES && (lowest - this.base) * 2 >= this.nodes.length) this.trim(lowest - this.base);
  }

  /** Drops the first `count` entries, which every reader has read. */
  private trim(count: number): void {
    const { nodes, kinds, last, base } = this;
    for (let index = 0; index < count; index++) {
      const node = nodes[index]!;
      if (last.get(node) === base + index) last.delete(node);
    }
    nodes.copyWithin(0, count);
    kinds.copyWithin(0, count);
    nodes.length -= count;
    kinds.length -= count;
    this.base = base + count;
  }
}

/** One consumer's position in a Scene's change log (`openRenderChangeReader`). */
export interface RenderChangeReader {
  /**
   * Visits every node changed since the last drain, once, with the kinds of change (`RenderChange` bits) it saw. False
   * (visiting none) when the reader fell too far behind and lost some: it must read the state it follows in full.
   */
  drain(visit: (node: Node, kinds: number) => void): boolean;
  /** Whether a drain would visit anything (or start over). */
  pending(): boolean;
  dispose(): void;
}

class Reader implements RenderChangeReader {
  cursor: number;
  overflowed = false;
  readonly kinds: number;
  private readonly scene: JournalScene;
  private readonly journal: Journal;

  constructor(scene: JournalScene, journal: Journal, kinds: number) {
    this.scene = scene;
    this.journal = journal;
    this.kinds = kinds;
    this.cursor = journal.end;
  }

  pending(): boolean {
    return this.overflowed || this.cursor < this.journal.end;
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
    for (let at = this.cursor - journal.base; at < journal.nodes.length; at++) {
      const kinds = journal.kinds[at]! & this.kinds;
      if (kinds) visit(journal.nodes[at]!, kinds);
    }
    this.cursor = journal.end;
    journal.settle();
    return true;
  }

  dispose(): void {
    const journal = this.journal;
    if (!journal.readers.delete(this)) return;
    if (this.kinds & RenderChange.Bounds) boundsReaders -= 1;
    if (journal.readers.size === 0) {
      journal.clear();
      if (this.scene._hapticRenderChanges === journal) delete this.scene._hapticRenderChanges;
    } else journal.settle();
  }
}

/** Every kind of change but `Bounds` and `Ready`, which a reader names when it follows them. */
const DEFAULT_KINDS = RenderChange.Transform | RenderChange.Visibility | RenderChange.Enabled | RenderChange.Material |
  RenderChange.Geometry | RenderChange.Other | RenderChange.Style | RenderChange.Dispatch;

/**
 * Opens a reader of `scene`'s changes of `kinds` (`RenderChange` bits; all but `Bounds` and `Ready` by default). The Scene records
 * a kind only while some reader reads it: without one each hooked Babylon write costs a field read.
 */
export function openRenderChangeReader(scene: Scene, kinds: number = DEFAULT_KINDS): RenderChangeReader {
  install();
  const target = scene as JournalScene;
  let journal = target._hapticRenderChanges;
  if (!journal) {
    journal = target._hapticRenderChanges = new Journal();
    const owned = journal;
    scene.onDisposeObservable.addOnce(() => {
      for (const reader of owned.readers) if (reader.kinds & RenderChange.Bounds) boundsReaders -= 1;
      owned.readers.clear();
      owned.clear();
      if (target._hapticRenderChanges === owned) delete target._hapticRenderChanges;
    });
  }
  const reader = new Reader(target, journal, kinds);
  journal.readers.add(reader);
  if (kinds & RenderChange.Bounds) boundsReaders += 1;
  journal.frontier = journal.end;
  journal.wanted |= kinds;
  return reader;
}

/** Records a change of Haptic-owned state that no Babylon write reaches (`RenderChange.Other` unless `kinds` says). */
export function noteRenderChange(node: Node, kinds: number = RenderChange.Other): void {
  journalOf(node)?.note(node, kinds);
}

/**
 * The meshes whose bounding box or sphere a reader follows (`followBounds`): a write of its world values notes them
 * (`RenderChange.Bounds`). Weak both ways: a bounding info another holder keeps alive keeps no disposed mesh with it.
 */
const boundsOwners = new WeakMap<object, WeakRef<AbstractMesh> | WeakRef<AbstractMesh>[]>();
/** Open readers of `Bounds`, in every Scene: with none, a bounds write costs one branch. */
let boundsReaders = 0;

/**
 * Has every later write of `info`'s world values note `mesh` (`RenderChange.Bounds`) in its Scene's journal, while a
 * reader reads that kind. `info` is the bounding info `mesh.getBoundingInfo()` returned; one several meshes share notes
 * each of them. A replaced bounding info is noted by itself (`setBoundingInfo`, `buildBoundingInfo`), and the reader then
 * follows the new one.
 */
export function followBounds(mesh: AbstractMesh, info: BoundingInfo): boolean {
  install();
  const box = own(info.boundingBox, mesh), sphere = own(info.boundingSphere, mesh);
  return box || sphere;
}

/**
 * Has `mesh` follow `target`; true when another live mesh follows it too (a shared bounding info, whose world values
 * are whichever owner's lazy update ran last). The owners already there need no note: their copies hold the values as
 * they are, and every later write notes them.
 */
function own(target: object, mesh: AbstractMesh): boolean {
  const owners = boundsOwners.get(target);
  if (!owners) {
    boundsOwners.set(target, new WeakRef(mesh));
    return false;
  }
  if (!Array.isArray(owners)) {
    const owner = owners.deref();
    if (owner === mesh) return false;
    if (!owner) {
      boundsOwners.set(target, new WeakRef(mesh));
      return false;
    }
    boundsOwners.set(target, [owners, new WeakRef(mesh)]);
    return true;
  }
  let live = 0, known = false;
  for (const owner of owners) {
    const held = owner.deref();
    if (!held) continue;
    owners[live++] = owner;
    if (held === mesh) known = true;
  }
  owners.length = live;
  if (!known) owners.push(new WeakRef(mesh));
  return owners.length > 1;
}

/** The mesh `readBounds` is reading, whose own lazy update notes nothing. */
let readingMesh: AbstractMesh | null = null;

/**
 * `mesh.getBoundingInfo()` for a reader that follows its bounds, noting nothing for `mesh` from Babylon's lazy update it
 * may run: that update follows a world matrix computed since the last read, which the journal named (`Transform`), so
 * every reader of the mesh's bounds reads them again anyway. Another mesh the write reaches (one sharing the bounding
 * info) is noted as ever.
 */
export function readBounds(mesh: AbstractMesh): BoundingInfo {
  const reading = readingMesh;
  readingMesh = mesh;
  try {
    return mesh.getBoundingInfo();
  } finally {
    readingMesh = reading;
  }
}

/**
 * Notes the meshes that follow `target` (a bounding box or sphere whose world values were just written), but the one
 * being read. Owners that were collected are dropped here, where a shared box's writes land.
 */
function noteBoundsWrite(target: object): void {
  const owners = boundsOwners.get(target);
  if (!owners) return;
  if (!Array.isArray(owners)) {
    const mesh = owners.deref();
    if (!mesh) boundsOwners.delete(target);
    else if (mesh !== readingMesh) journalOf(mesh)?.note(mesh, RenderChange.Bounds);
    return;
  }
  let live = 0;
  for (const owner of owners) {
    const mesh = owner.deref();
    if (!mesh) continue;
    owners[live++] = owner;
    if (mesh !== readingMesh) journalOf(mesh)?.note(mesh, RenderChange.Bounds);
  }
  owners.length = live;
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
const HOOKED_NAMES = ["isVisible", "inheritVisibility", "visibility", "material", "_setMaterial", "_syncParentEnabledState", "_afterComputeWorldMatrix",
  "setMaterialForRenderPass", "renderingGroupId", "layerMask", "hasVertexAlpha", "addLODLevel", "removeLODLevel"];

const hookedPrototypes = new Set<object>();
const followedPrototypes = new WeakMap<object, boolean>();

/**
 * Whether the journal hears every visibility, enabled, Material and dispatch write of `node`: false when its class (beyond
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
 * Installs the hooks once (`hook`). Kept apart from them because a function whose locals its closures capture makes
 * their context on every call, before its first line runs: the hot callers (`geometryBufferLayout` once per polled
 * source a frame, `journalFollows`) would allocate it each time.
 */
function install(): void {
  if (!installed) hook();
}

/**
 * Pinned 9.29 adapter, installed once on the first reader: wraps the prototype methods and accessors where Babylon
 * writes what a visual draws, so each write notes its node in its Scene's journal. Prototype wrappers rather than a
 * hunk of the Babylon patch: they need no rebuild of the patched package, they stay out of every Scene without a
 * reader, and the pin review checks them in one place. Each wrapper calls the original first and notes only an actual
 * change where the write can be a no-op.
 */
function hook(): void {
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
  type PassMaterial = { setMaterialForRenderPass: (this: AbstractMesh, id: number, value: unknown) => void };
  const passMaterialPrototype = AbstractMesh.prototype as unknown as PassMaterial;
  const setForPass = passMaterialPrototype.setMaterialForRenderPass;
  passMaterialPrototype.setMaterialForRenderPass = function (this: AbstractMesh, id: number, value: unknown) {
    const was = this.getMaterialForRenderPass(id);
    setForPass.call(this, id, value);
    const journal = journalOf(this);
    if (journal && was !== this.getMaterialForRenderPass(id)) noteMesh(journal, this, RenderChange.Material);
  };

  // An instance's draws queue by its source's rendering group and vertex alpha, so a source's write notes its instances.
  for (const name of ["renderingGroupId", "layerMask", "hasVertexAlpha"]) {
    const property = accessor(AbstractMesh.prototype, name);
    Object.defineProperty(AbstractMesh.prototype, name, {
      ...property,
      set(this: AbstractMesh, value: unknown) {
        const was: unknown = property.get!.call(this);
        property.set!.call(this, value);
        const journal = journalOf(this);
        if (journal && !Object.is(was, property.get!.call(this))) noteMesh(journal, this, RenderChange.Dispatch);
      },
    });
  }
  // The level a master gains or loses changes too: a level is blocked (`isBlocked`) while it has a master.
  type LodMethods = Record<"addLODLevel" | "removeLODLevel", (this: Mesh, ...args: unknown[]) => Mesh>;
  const lodPrototype = Mesh.prototype as unknown as LodMethods;
  for (const [name, levelAt] of [["addLODLevel", 1], ["removeLODLevel", 0]] as const) {
    const original = lodPrototype[name];
    lodPrototype[name] = function (this: Mesh, ...args: unknown[]) {
      const result = original.apply(this, args);
      const journal = journalOf(this);
      if (journal) noteMesh(journal, this, RenderChange.Dispatch);
      const level = args[levelAt];
      if (journal && level instanceof Mesh) journal.note(level, RenderChange.Dispatch);
      return result;
    };
  }

  // The only writer of a node's ready flag after construction; an instance reads its source's.
  const readyPrototype = Node.prototype as unknown as { _setReady: (this: Node, state: boolean) => void };
  const setReady = readyPrototype._setReady;
  if (typeof setReady !== "function") throw new Error("Babylon 9.29 Node._setReady not found");
  readyPrototype._setReady = function (this: Node, state: boolean) {
    const storage = internals(this)._nodeDataStorage, was = storage._isReady;
    setReady.call(this, state);
    const journal = journalOf(this);
    if (!journal || was === storage._isReady) return;
    if (this instanceof AbstractMesh) noteMesh(journal, this, RenderChange.Ready);
    else journal.note(this, RenderChange.Ready);
  };
  // An instance taking a source (its construction, an instance pool's re-key) reads that source's ready flag and visibility.
  const instancePrototype = Mesh.prototype as unknown as { addInstance: (this: Mesh, instance: InstancedMesh) => unknown };
  const addInstance = instancePrototype.addInstance;
  if (typeof addInstance !== "function") throw new Error("Babylon 9.29 Mesh.addInstance not found");
  instancePrototype.addInstance = function (this: Mesh, instance: InstancedMesh) {
    const result = addInstance.call(this, instance);
    journalOf(instance)?.note(instance, RenderChange.Ready);
    return result;
  };
  // A replaced scaling vector (an in-place write changes the world matrix it is computed into).
  const scaling = accessor(TransformNode.prototype, "scaling");
  Object.defineProperty(TransformNode.prototype, "scaling", {
    ...scaling,
    set(this: TransformNode, value: unknown) {
      const was: unknown = scaling.get!.call(this);
      scaling.set!.call(this, value);
      if (was !== scaling.get!.call(this)) journalOf(this)?.note(this, RenderChange.Transform);
    },
  });

  // A mesh's bounding info replaced: the new one's world values are what its culls read from now on.
  type BoundsMethods = Record<"setBoundingInfo" | "buildBoundingInfo", (this: AbstractMesh, ...args: unknown[]) => unknown>;
  const boundsPrototype = AbstractMesh.prototype as unknown as BoundsMethods;
  for (const name of ["setBoundingInfo", "buildBoundingInfo"] as const) {
    const original = boundsPrototype[name];
    if (typeof original !== "function") throw new Error(`Babylon 9.29 AbstractMesh.${name} not found`);
    boundsPrototype[name] = function (this: AbstractMesh, ...args: unknown[]) {
      const result = original.apply(this, args);
      journalOf(this)?.note(this, RenderChange.Bounds);
      return result;
    };
  }
  // Every write of a bounding box's or sphere's world values: `BoundingInfo.update`, `reConstruct` (the constructor,
  // `centerOn`, `encapsulate`) and `scale` all end in these.
  for (const prototype of [BoundingBox.prototype, BoundingSphere.prototype] as unknown as Array<{ _update: (this: object, world: unknown) => void }>) {
    const update = prototype._update;
    if (typeof update !== "function") throw new Error("Babylon 9.29 bounding _update not found");
    prototype._update = function (this: object, world: unknown) {
      update.call(this, world);
      if (boundsReaders > 0) noteBoundsWrite(this);
    };
  }

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
    if (journal) for (const mesh of internals(this)._meshes) if (mesh) noteMesh(journal, mesh, RenderChange.Geometry);
  };
  const applyToMesh = geometryPrototype.applyToMesh;
  geometryPrototype.applyToMesh = function (this: Geometry, mesh: Mesh) {
    applyToMesh.call(this, mesh);
    const journal = mesh ? journalOf(mesh) : undefined;
    if (journal) noteMesh(journal, mesh, RenderChange.Geometry);
  };
  const releaseForMesh = geometryPrototype.releaseForMesh;
  // `Geometry.dispose` walks its mesh list by index while each release shortens it, so Babylon itself asks to release
  // `undefined` for a geometry several meshes share; its own method ignores that.
  geometryPrototype.releaseForMesh = function (this: Geometry, mesh: Mesh | undefined, shouldDispose?: boolean) {
    releaseForMesh.call(this, mesh as Mesh, shouldDispose);
    const journal = mesh ? journalOf(mesh) : undefined;
    if (journal) noteMesh(journal, mesh!, RenderChange.Geometry);
  };

  // Where Babylon 9.29 replaces a geometry's vertex buffers or index buffer, or their updatability: `removeVerticesData`
  // notifies nothing, so `onGeometryUpdated` alone cannot tell.
  const layoutPrototype = Geometry.prototype as unknown as Record<string, (this: Geometry, ...args: unknown[]) => unknown>;
  for (const name of ["setVerticesBuffer", "removeVerticesData", "setIndices", "setIndexBuffer"]) {
    const original = layoutPrototype[name];
    if (typeof original !== "function") throw new Error(`Babylon 9.29 Geometry.${name} not found`);
    layoutPrototype[name] = function (this: Geometry, ...args: unknown[]) {
      const layout = this as unknown as LayoutGeometry;
      layout._hapticBufferLayout = (layout._hapticBufferLayout ?? 0) + 1;
      return original.apply(this, args);
    };
  }
}

type LayoutGeometry = Geometry & { _hapticBufferLayout?: number };

/**
 * A number that moves whenever `geometry`'s vertex buffers or index buffer are replaced or removed (`setVerticesBuffer`,
 * `removeVerticesData`, `setIndices`, `setIndexBuffer`): what decides which of its buffers can be rewritten in place.
 * Counted for every geometry once any reader opened.
 */
export function geometryBufferLayout(geometry: Geometry): number {
  install();
  return (geometry as LayoutGeometry)._hapticBufferLayout ?? 0;
}
