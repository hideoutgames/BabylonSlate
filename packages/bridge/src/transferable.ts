import { snapshotFloatCount } from "./layout";

/** Spare buffers kept for reuse; further returns are left to the GC. */
const MAX_FREE_BUFFERS = 2;

/**
 * Transferable ping-pong: writer fills a buffer, commits it as an ArrayBuffer
 * to transfer, then recycles returned buffers for the next write.
 */
export class TransferablePingPong {
  readonly maxActors: number;
  readonly floatCount: number;
  private free: ArrayBuffer[];
  private writing: Float32Array | null = null;

  constructor(maxActors: number) {
    this.maxActors = maxActors;
    this.floatCount = snapshotFloatCount(maxActors);
    const bytes = this.floatCount * 4;
    this.free = [new ArrayBuffer(bytes), new ArrayBuffer(bytes)];
  }

  /**
   * A recycled buffer keeps its previous contents: the writer must write the
   * header, and rows past its `actorCount` stay stale for readers to ignore.
   */
  beginWrite(): Float32Array {
    const ab = this.free.pop() ?? new ArrayBuffer(this.floatCount * 4);
    this.writing = new Float32Array(ab);
    return this.writing;
  }

  commitWrite(): ArrayBuffer {
    if (!this.writing) {
      throw new Error("TransferablePingPong.commitWrite without beginWrite");
    }
    const ab = this.writing.buffer as ArrayBuffer;
    this.writing = null;
    return ab;
  }

  /** Abandon a `beginWrite()` that produced nothing worth sending this frame. */
  cancelWrite(): void {
    if (!this.writing) return;
    const ab = this.writing.buffer as ArrayBuffer;
    this.writing = null;
    this.recycle(ab);
  }

  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength === this.floatCount * 4 && this.free.length < MAX_FREE_BUFFERS) {
      this.free.push(buffer);
    }
  }

  grow(capacity: number): TransferablePingPong {
    return capacity > this.maxActors ? new TransferablePingPong(capacity) : this;
  }
}
