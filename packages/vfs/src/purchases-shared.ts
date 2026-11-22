/** Internal helpers for the purchases adapters; not part of the package API. */

/** Picks the requested package of the current offering, never a fallback. */
export function offeringPackage<T extends { identifier: string }>(
  offering: { availablePackages: readonly T[] } | null | undefined,
  packageId: string,
): T {
  if (!offering) throw new Error("No subscription is available to buy right now.");
  const found = offering.availablePackages.find((candidate) => candidate.identifier === packageId);
  if (!found) {
    throw new Error(`The subscription package "${packageId}" is not available right now.`);
  }
  return found;
}

/** Runs async operations one at a time; a failure does not stop later ones. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
