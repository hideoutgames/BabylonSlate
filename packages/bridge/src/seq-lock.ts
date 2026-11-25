import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_DIRTY_FLAG_FULL,
  SNAPSHOT_DIRTY_FLAG_TRACKED,
  SNAPSHOT_DIRTY_META_WORDS,
  SNAPSHOT_HEADER_FLOATS,
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  actorSlotOffset,
  snapshotDirtyBitsetWords,
  snapshotDirtyMetaOffset,
  snapshotFloatCount,
} from "./layout";
import { isPublishedSnapshot, snapshotActiveFloatCount, snapshotDirtyView } from "./snapshot-buffer";

const SEQ_INDEX = 7;
const MAX_READ_RETRIES = 64;
/** Control word indices in the shared 4-int32 control buffer. */
const CTRL_PUBLISHED_INDEX = 0;
const CTRL_PUBLISH_SERIAL = 1;
const CTRL_MAX_ACTORS = 2;
const CTRL_GENERATION = 3;
const CTRL_WORDS = 4;

/** Backing SharedArrayBuffers of a cross-thread `SeqLockSnapshotPair`. */
export interface SharedSnapshotBuffers {
  bufferA: SharedArrayBuffer;
  bufferB: SharedArrayBuffer;
  control: SharedArrayBuffer;
}

/** Result of an incremental/dirty-aware seq-lock snapshot read. */
export interface DirtySnapshotReadResult {
  /** False when the published serial has not changed since `lastSerial` (zero bytes copied). */
  changed: boolean;
  /** True when the reader copied all live rows (layout/origin/first-frame/skipped > 2 publishes). */
  full: boolean;
  /** Number of dirty row indices written to `dirtyRowsOut` when `changed && !full`. */
  dirtyCount: number;
  /** Published serial of the read snapshot. */
  serial: number;
  /** Live actor row count of the read snapshot. */
  actorCount: number;
}

function seqIntView(buf: Float32Array): Int32Array {
  return new Int32Array(buf.buffer, buf.byteOffset + SEQ_INDEX * 4, 1);
}

/** One buffer of the pair with its sequence word's and dirty tail's views, made once so reads and writes allocate nothing. */
type SeqBuffer = {
  readonly floats: Float32Array;
  readonly seq: Int32Array;
  readonly dirty: Uint32Array | null;
  readonly atomic: boolean;
};

/**
 * Double-buffered SharedArrayBuffer snapshot pair with an Atomics seq-lock.
 * Falls back to plain ArrayBuffers when SharedArrayBuffer is unavailable
 * (still useful for in-process unit tests of the publish/read protocol).
 */
export class SeqLockSnapshotPair {
  readonly maxActors: number;
  readonly floatCount: number;
  readonly dirtyOffset: number;
  private readonly buffers: [SeqBuffer, SeqBuffer];
  private readonly control: Int32Array;
  private readonly atomicControl: boolean;
  private writeIndex = 0;
  private localSerial = 0;

  private constructor(
    maxActors: number,
    buffers: [Float32Array, Float32Array],
    control: Int32Array,
    useAtomics: boolean,
  ) {
    this.maxActors = maxActors;
    this.floatCount = buffers[0].length;
    this.dirtyOffset = snapshotDirtyMetaOffset(maxActors);
    const entry = (floats: Float32Array): SeqBuffer => ({
      floats,
      seq: seqIntView(floats),
      dirty: snapshotDirtyView(floats, maxActors),
      atomic: useAtomics && floats.buffer instanceof SharedArrayBuffer,
    });
    this.buffers = [entry(buffers[0]), entry(buffers[1])];
    this.control = control;
    this.atomicControl = useAtomics && control.buffer instanceof SharedArrayBuffer;
  }

  static create(maxActors: number, generation = 0): SeqLockSnapshotPair {
    const floats = snapshotFloatCount(maxActors);
    const bytes = floats * 4;
    const canSab =
      typeof SharedArrayBuffer !== "undefined" &&
      typeof Atomics !== "undefined";
    if (canSab) {
      const a = new Float32Array(new SharedArrayBuffer(bytes));
      const b = new Float32Array(new SharedArrayBuffer(bytes));
      const control = new Int32Array(new SharedArrayBuffer(CTRL_WORDS * 4));
      control[CTRL_PUBLISHED_INDEX] = 1;
      control[CTRL_PUBLISH_SERIAL] = 0;
      control[CTRL_MAX_ACTORS] = maxActors;
      control[CTRL_GENERATION] = generation;
      return new SeqLockSnapshotPair(maxActors, [a, b], control, true);
    }
    const control = new Int32Array(CTRL_WORDS);
    control[CTRL_PUBLISHED_INDEX] = 1;
    control[CTRL_PUBLISH_SERIAL] = 0;
    control[CTRL_MAX_ACTORS] = maxActors;
    control[CTRL_GENERATION] = generation;
    return new SeqLockSnapshotPair(
      maxActors,
      [new Float32Array(floats), new Float32Array(floats)],
      control,
      false,
    );
  }

  /** Attach a reader view on another thread to an existing SAB snapshot pair. */
  static fromSharedBuffers(
    maxActors: number,
    shared: SharedSnapshotBuffers,
  ): SeqLockSnapshotPair {
    const floats = snapshotFloatCount(maxActors);
    const a = new Float32Array(shared.bufferA, 0, floats);
    const b = new Float32Array(shared.bufferB, 0, floats);
    const control = new Int32Array(shared.control, 0, CTRL_WORDS);
    return new SeqLockSnapshotPair(maxActors, [a, b], control, true);
  }

  static grow(current: SeqLockSnapshotPair, capacity: number, generation = 0): SeqLockSnapshotPair {
    return capacity > current.maxActors ? SeqLockSnapshotPair.create(capacity, generation) : current;
  }

  /** The underlying SharedArrayBuffers when SAB-backed, or null in plain ArrayBuffer mode. */
  sharedBuffers(): SharedSnapshotBuffers | null {
    const a = this.buffers[0].floats.buffer;
    const b = this.buffers[1].floats.buffer;
    const ctrl = this.control.buffer;
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      a instanceof SharedArrayBuffer &&
      b instanceof SharedArrayBuffer &&
      ctrl instanceof SharedArrayBuffer
    ) {
      return { bufferA: a, bufferB: b, control: ctrl };
    }
    return null;
  }

  /** Latest published serial (0 before first publish). Single atomic load. */
  publishedSerial(): number {
    return this.atomicControl
      ? Atomics.load(this.control, CTRL_PUBLISH_SERIAL) >>> 0
      : (this.control[CTRL_PUBLISH_SERIAL]! >>> 0);
  }

  /** The dirty-tail Uint32Array view of the active write buffer, or null when capacity is 0. */
  writerDirtyView(): Uint32Array | null {
    return this.buffers[this.writeIndex]!.dirty;
  }

  writerBuffer(): Float32Array {
    return this.buffers[this.writeIndex]!.floats;
  }

  /**
   * The most recently published buffer, which `beginWrite` does not return. The
   * writer may read it while writing the other, e.g. to carry rows forward.
   */
  publishedBuffer(): Float32Array {
    return this.buffers[1 - this.writeIndex]!.floats;
  }

  /** Begin a write: bump seq to odd on the active write buffer. */
  beginWrite(): Float32Array {
    const entry = this.buffers[this.writeIndex]!;
    this.setSeq(entry, this.getSeq(entry) | 1);
    return entry.floats;
  }

  /** Finish write: set seq even, publish index + serial atomically, and flip the write index. */
  publish(): void {
    const publishedIdx = this.writeIndex;
    const entry = this.buffers[publishedIdx]!;
    const buf = entry.floats;
    const nextEven = (this.getSeq(entry) + 1) & ~1;
    buf[0] = SNAPSHOT_MAGIC_F32;
    buf[1] = SNAPSHOT_LAYOUT_VERSION;
    this.setSeq(entry, nextEven);
    this.localSerial = (this.localSerial + 1) >>> 0 || 1;
    if (this.atomicControl) {
      Atomics.store(this.control, CTRL_PUBLISHED_INDEX, publishedIdx);
      Atomics.store(this.control, CTRL_PUBLISH_SERIAL, this.localSerial | 0);
    } else {
      this.control[CTRL_PUBLISHED_INDEX] = publishedIdx;
      this.control[CTRL_PUBLISH_SERIAL] = this.localSerial | 0;
    }
    this.writeIndex = 1 - publishedIdx;
  }

  /**
   * Copy the most recently published snapshot into `out`: its header, its
   * `actorCount` rows, and (when `out` has room) its dirty metadata + active
   * bitset words. Returns false if the buffer was torn after retries or if
   * nothing has been published yet.
   */
  tryRead(out: Float32Array): boolean {
    const dirtyOffset = this.dirtyOffset;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      const idx = this.publishedIndex();
      const entry = this.buffers[idx]!;
      const src = entry.floats;
      const seq1 = this.getSeq(entry);
      if ((seq1 & 1) === 1) {
        continue;
      }
      // A torn `actorCount` only sizes this copy; the seq recheck rejects it.
      const activeFloats = snapshotActiveFloatCount(src);
      out.set(src.subarray(0, activeFloats));
      if (this.maxActors > 0 && out.length >= this.floatCount) {
        const actorCount = Math.min(this.maxActors, Math.max(0, Math.floor(src[4] ?? 0)));
        const tailLen = SNAPSHOT_DIRTY_META_WORDS + snapshotDirtyBitsetWords(actorCount);
        out.set(src.subarray(dirtyOffset, dirtyOffset + tailLen), dirtyOffset);
      }
      const seq2 = this.getSeq(entry);
      if (seq1 === seq2 && (seq2 & 1) === 0 && this.publishedIndex() === idx) {
        return isPublishedSnapshot(out);
      }
    }
    return false;
  }

  /**
   * Read the newest published snapshot into `out`, copying only dirty rows when
   * `lastSerial` is within 2 publishes (matching `SnapshotPublisher`'s 2-buffer
   * `dirtySlotFrames` retention) and layout/origin/actorCount did not change.
   * Returns `null` if nothing has been published yet or every retry tore.
   */
  tryReadDirty(
    out: Float32Array,
    lastSerial: number,
    lastActorCount: number,
    dirtyRowsOut: Uint32Array,
  ): DirtySnapshotReadResult | null {
    const serial0 = this.publishedSerial();
    if (serial0 === 0) return null;
    if (serial0 === lastSerial) {
      return { changed: false, full: false, dirtyCount: 0, serial: serial0, actorCount: lastActorCount };
    }
    const maxActors = this.maxActors;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      const idx = this.publishedIndex();
      const entry = this.buffers[idx]!;
      const src = entry.floats;
      const seq1 = this.getSeq(entry);
      if ((seq1 & 1) === 1) continue;
      const serial = this.publishedSerial();
      const rawCount = src[4] ?? 0;
      const actorCount = rawCount > 0 ? Math.min(maxActors, Math.floor(rawCount)) : 0;
      const dirtyView = entry.dirty;
      const dirtyFlags = dirtyView ? dirtyView[1]! : 0;
      const serialDelta = (serial - lastSerial) >>> 0;
      const canIncremental =
        dirtyView !== null &&
        (dirtyFlags & SNAPSHOT_DIRTY_FLAG_TRACKED) !== 0 &&
        (dirtyFlags & SNAPSHOT_DIRTY_FLAG_FULL) === 0 &&
        lastSerial > 0 &&
        serialDelta >= 1 &&
        serialDelta <= 2 &&
        actorCount === lastActorCount &&
        dirtyRowsOut.length >= actorCount;

      if (canIncremental) {
        out.set(src.subarray(0, SNAPSHOT_HEADER_FLOATS));
        const words = snapshotDirtyBitsetWords(actorCount);
        let dirtyCount = 0;
        for (let w = 0; w < words; w++) {
          let bits = dirtyView[SNAPSHOT_DIRTY_META_WORDS + w]!;
          while (bits !== 0) {
            const lsb = bits & -bits;
            const bit = 31 - Math.clz32(lsb);
            const row = (w << 5) + bit;
            if (row < actorCount) {
              const offset = actorSlotOffset(row);
              out.set(src.subarray(offset, offset + SNAPSHOT_ACTOR_STRIDE), offset);
              dirtyRowsOut[dirtyCount++] = row;
            }
            bits ^= lsb;
          }
        }
        const seq2 = this.getSeq(entry);
        if (seq1 === seq2 && (seq2 & 1) === 0 && this.publishedIndex() === idx) {
          if (!isPublishedSnapshot(out)) return null;
          return { changed: true, full: false, dirtyCount, serial, actorCount };
        }
        continue;
      }

      const activeFloats = snapshotActiveFloatCount(src);
      out.set(src.subarray(0, activeFloats));
      const seq2 = this.getSeq(entry);
      if (seq1 === seq2 && (seq2 & 1) === 0 && this.publishedIndex() === idx) {
        if (!isPublishedSnapshot(out)) return null;
        return { changed: true, full: true, dirtyCount: 0, serial, actorCount };
      }
    }
    return null;
  }

  private publishedIndex(): number {
    return this.atomicControl
      ? Atomics.load(this.control, CTRL_PUBLISHED_INDEX) & 1
      : this.control[CTRL_PUBLISHED_INDEX]! & 1;
  }

  private getSeq(entry: SeqBuffer): number {
    return entry.atomic ? Atomics.load(entry.seq, 0) : (entry.seq[0] ?? 0);
  }

  private setSeq(entry: SeqBuffer, value: number): void {
    if (entry.atomic) Atomics.store(entry.seq, 0, value);
    else entry.seq[0] = value;
  }
}
