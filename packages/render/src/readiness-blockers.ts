/** How many blockers one probe names: the first ones it meets, in probe order. */
export const MAX_READINESS_BLOCKERS = 6;

let collecting: string[] | undefined;

/**
 * Runs a strict readiness probe, naming into `into` what it finds unready (`noteReadinessBlocker`): the first
 * `MAX_READINESS_BLOCKERS`, in the order the probe meets them. Probes nest (a render target's own probe inside the
 * scene's); the outermost collector keeps every name.
 */
export function collectReadinessBlockers<T>(into: string[], probe: () => T): T {
  if (collecting) return probe();
  into.length = 0;
  collecting = into;
  try {
    return probe();
  } finally {
    collecting = undefined;
  }
}

/** Names something the running probe found unready; `describe` runs only while a collector listens and has room. */
export function noteReadinessBlocker(describe: () => string): void {
  if (!collecting || collecting.length >= MAX_READINESS_BLOCKERS) return;
  const text = describe();
  if (!collecting.includes(text)) collecting.push(text);
}
