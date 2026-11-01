/**
 * Values held by script frames that wait on Delay or another latent node. A
 * promise hides them, so compiled async entries register a getter over their
 * locals while they run (`ctx.holdFrame`); the collector treats the values as
 * roots. Insertion order keeps every pass deterministic.
 */
export class LatentFrameRoots {
  private readonly frames = new Set<() => readonly unknown[]>();

  /** Registers a running frame; the returned function ends it. */
  hold(values: () => readonly unknown[]): () => void {
    this.frames.add(values);
    return () => {
      this.frames.delete(values);
    };
  }

  forEach(visit: (value: unknown) => void): void {
    for (const values of this.frames) for (const value of values()) visit(value);
  }

  get size(): number {
    return this.frames.size;
  }
}
