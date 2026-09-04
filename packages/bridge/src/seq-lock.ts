import {
  SNAPSHOT_LAYOUT_VERSION,
  SNAPSHOT_MAGIC_F32,
  snapshotFloatCount,
} from "./layout";
import { isPublishedSnapshot } from "./snapshot-buffer";

const SEQ_INDEX = 7;
const MAX_READ_RETRIES = 64;

function seqIntView(buf: Float32Array): Int32Array {
  return new Int32Array(buf.buffer, buf.byteOffset + SEQ_INDEX * 4, 1);
}

/**
 * Double-buffered SharedArrayBuffer snapshot pair with an Atomics seq-lock.
 * Falls back to plain ArrayBuffers when SharedArrayBuffer is unavailable
 * (still useful for in-process unit tests of the publish/read protocol).
 */
export class SeqLockSnapshotPair {
  readonly maxActors: number;
  readonly floatCount: number;
  private readonly buffers: [Float32Array, Float32Array];
  private writeIndex = 0;
  private readonly useAtomics: boolean;

  private constructor(
    maxActors: number,
    buffers: [Float32Array, Float32Array],
    useAtomics: boolean,
  ) {
    this.maxActors = maxActors;
    this.floatCount = buffers[0].length;
    this.buffers = buffers;
    this.useAtomics = useAtomics;
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
    return this.buffers[this.writeIndex]!;
  }

  /** Begin a write: bump seq to odd on the active write buffer. */
  beginWrite(): Float32Array {
    const buf = this.writerBuffer();
    const current = this.getSeq(buf);
    this.setSeq(buf, current | 1);
    return buf;
  }

  /** Finish write: set seq even and flip the write index for the next frame. */
  publish(): void {
    const buf = this.writerBuffer();
    const nextEven = (this.getSeq(buf) + 1) & ~1;
    buf[0] = SNAPSHOT_MAGIC_F32;
    buf[1] = SNAPSHOT_LAYOUT_VERSION;
    this.setSeq(buf, nextEven);
    this.writeIndex = 1 - this.writeIndex;
  }

  /**
   * Copy the most recently published buffer into `out`.
   * Returns false if the buffer was torn after retries, or if nothing
   * has been published yet (spare buffers are zeroed and look like
   * `actorCount: 0`).
   */
  tryRead(out: Float32Array): boolean {
    const readIndex = 1 - this.writeIndex;
    const src = this.buffers[readIndex]!;
    for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
      const seq1 = this.getSeq(src);
      if ((seq1 & 1) === 1) {
        continue;
      }
      out.set(src);
      const seq2 = this.getSeq(src);
      if (seq1 === seq2 && (seq2 & 1) === 0) {
        return isPublishedSnapshot(out);
      }
    }
    return false;
  }

  private getSeq(buf: Float32Array): number {
    if (this.useAtomics && buf.buffer instanceof SharedArrayBuffer) {
      return Atomics.load(seqIntView(buf), 0);
    }
    return seqIntView(buf)[0] ?? 0;
  }

  private setSeq(buf: Float32Array, value: number): void {
    if (this.useAtomics && buf.buffer instanceof SharedArrayBuffer) {
      Atomics.store(seqIntView(buf), 0, value);
      return;
    }
    seqIntView(buf)[0] = value;
  }
}
