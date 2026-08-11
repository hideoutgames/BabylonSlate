import { snapshotFloatCount } from "./layout";

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

  beginWrite(): Float32Array {
    const ab = this.free.pop() ?? new ArrayBuffer(this.floatCount * 4);
    this.writing = new Float32Array(ab);
    this.writing.fill(0);
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

  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength === this.floatCount * 4) {
      this.free.push(buffer);
    }
  }
}
