import { useSyncExternalStore } from "react";

/**
 * How often a transfer's byte count reaches its readers. Requests end far
 * more often than a label needs to change (an LFS push sends a PUT and a
 * verify per object), so the count is published at most this often.
 */
export const TRANSFER_PUBLISH_MS = 100;

/**
 * Bytes a running transfer has sent and received, kept apart from the state
 * it belongs to so that only the transfer labels re-render as it grows.
 */
export class TransferBytes {
  private total = 0;
  private published = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The count as last published. */
  readonly getSnapshot = (): number => this.published;

  /** Adds one request's bytes; readers see the total within `TRANSFER_PUBLISH_MS`. */
  add(count: number): void {
    this.total += count;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish(this.total);
    }, TRANSFER_PUBLISH_MS);
  }

  /** Back to zero at once, for the next transfer. */
  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.total = 0;
    this.publish(0);
  }

  private publish(value: number): void {
    if (value === this.published) return;
    this.published = value;
    for (const listener of this.listeners) listener();
  }
}

/** The transfer's byte count; re-renders at most every `TRANSFER_PUBLISH_MS`. */
export function useTransferBytes(bytes: TransferBytes): number {
  return useSyncExternalStore(bytes.subscribe, bytes.getSnapshot, bytes.getSnapshot);
}
