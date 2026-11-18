/**
 * The mean of the last `capacity` values added, for counters a display shows as they change. A clock that steps in
 * whole milliseconds (WebKit outside cross-origin isolation) times each frame as a whole number of them; the mean of
 * many such readings converges on the real time and shows its fractions. Allocates nothing per value.
 */
export class TrailingMean {
  private readonly values: Float64Array;
  private next = 0;
  private count = 0;
  private sum = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.count === this.values.length) this.sum -= this.values[this.next]!;
    else this.count += 1;
    this.values[this.next] = value;
    this.sum += value;
    this.next = (this.next + 1) % this.values.length;
  }

  /** The mean of the values held; null before the first. */
  mean(): number | null {
    return this.count ? this.sum / this.count : null;
  }
}
