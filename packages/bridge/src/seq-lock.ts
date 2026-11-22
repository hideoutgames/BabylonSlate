import {
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  snapshotFloatCount,
} from "./layout";
import { isPublishedSnapshot, snapshotActiveFloatCount } from "./snapshot-buffer";

const SEQ_INDEX = 7;
const MAX_READ_RETRIES = 64;

function seqIntView(buf: Float32Array): Int32Array {
  return new Int32Array(buf.buffer, buf.byteOffset + SEQ_INDEX * 4, 1);
}

/** One buffer of the pair with its sequence word's view, made once so reads and writes allocate nothing. */
type SeqBuffer = { readonly floats: Float32Array; readonly seq: Int32Array; readonly atomic: boolean };

/**
 * Double-buffered SharedArrayBuffer snapshot pair with an Atomics seq-lock.
 * Falls back to plain ArrayBuffers when SharedArrayBuffer is unavailable
 * (still useful for in-process unit tests of the publish/read protocol).
 */
export class SeqLockSnapshotPair {
  readonly maxActors: number;
  readonly floatCount: number;
  private readonly buffers: [SeqBuffer, SeqBuffer];
  private writeIndex = 0;

  private constructor(
    maxActors: number,
    buffers: [Float32Array, Float32Array],
    useAtomics: boolean,
  ) {
    this.maxActors = maxActors;
    this.floatCount = buffers[0].length;
    const entry = (floats: Float32Array): SeqBuffer => ({
      floats,
      seq: seqIntView(floats),
      atomic: useAtomics && floats.buffer instanceof SharedArrayBuffer,
    });
    this.buffers = [entry(buffers[0]), entry(buffers[1])];
  }

  static create(maxActors: number): SeqLockSnapshotPair {
    const floats = snapshotFloatCount(maxActors);
    const bytes = floats * 4;
    const canSab =
      typeof SharedArrayBuffer !== "undefined" &&
      typeof Atomics !== "undefined";
    if (canSab) {
      const a = new Float32Array(new SharedArrayBuffer(bytes));
      const b = new Float32Array(new SharedArrayBuffer(bytes));
      return new SeqLockSnapshotPair(maxActors, [a, b], true);
    }
    return new SeqLockSnapshotPair(
      maxActors,
      [new Float32Array(floats), new Float32Array(floats)],
      false,
    );
  }

  static grow(current: SeqLockSnapshotPair, capacity: number): SeqLockSnapshotPair {
    return capacity > current.maxActors ? SeqLockSnapshotPair.create(capacity) : current;
  }

  writerBuffer(): Float32Array {
    return this.buffers[this.writeIndex]!.floats;
  }

  /** Begin a write: bump seq to odd on the active write buffer. */
  beginWrite(): Float32Array {
    const entry = this.buffers[this.writeIndex]!;
    this.setSeq(entry, this.getSeq(entry) | 1);
    return entry.floats;
  }

  /** Finish write: set seq even and flip the write index for the next frame. */
  publish(): void {
    const entry = this.buffers[this.writeIndex]!;
    const buf = entry.floats;
    const nextEven = (this.getSeq(entry) + 1) & ~1;
    buf[0] = SNAPSHOT_MAGIC_F32;
    buf[1] = SNAPSHOT_LAYOUT_VERSION;
    this.setSeq(entry, nextEven);
    this.writeIndex = 1 - this.writeIndex;
  }

  /**
   * Copy the most recently published snapshot into `out`: its header and
   * `actorCount` rows only, so `out`'s later rows keep stale data that
   * readers must not consult. Returns false if the buffer was torn after
   * retries, or if nothing has been published yet (spare buffers are zeroed
   * and look like `actorCount: 0`).
   */
  tryRead(out: Float32Array): boolean {
    const entry = this.buffers[1 - this.writeIndex]!;
    const src = entry.floats;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      const seq1 = this.getSeq(entry);
      if ((seq1 & 1) === 1) {
        continue;
      }
      // A torn `actorCount` only sizes this copy; the seq recheck rejects it.
      out.set(src.subarray(0, snapshotActiveFloatCount(src)));
      const seq2 = this.getSeq(entry);
      if (seq1 === seq2 && (seq2 & 1) === 0) {
        return isPublishedSnapshot(out);
      }
    }
    return false;
  }

  private getSeq(entry: SeqBuffer): number {
    return entry.atomic ? Atomics.load(entry.seq, 0) : (entry.seq[0] ?? 0);
  }

  private setSeq(entry: SeqBuffer, value: number): void {
    if (entry.atomic) Atomics.store(entry.seq, 0, value);
    else entry.seq[0] = value;
  }
}
