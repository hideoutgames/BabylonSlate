/**
 * How the visibility index (`visibility-index.ts`) is kept honest and sized. A view that culls by the index runs
 * today's full path beside it on every 32nd query (a heal: the full path's list is the one used, and a difference is
 * counted) and, while `verifyVisibilityQueries` is on, on every query. A difference is a list that differs in length,
 * in a member or in order. Both must stay 0: the index answers with the full path's own arithmetic.
 *
 * Counts and times are summed per kind of view over every Scene, since the page loaded (`visibilityDiagnostics`).
 */

/** The kinds of view that cull by the index: a camera's own cull, and a planar reflection's list (Mirrors, water). */
export type VisibilityView = "main" | "mirror";

/** One kind of view's queries (`visibilityDiagnostics`). */
export interface VisibilityViewWork {
  /** Culls answered by the index, and the time they took (ms, the whole cull loop: flags and tests). */
  queries: number;
  queryMs: number;
  /** Culls that also ran the full path (every 32nd, or all while verifying), and the time the full path took (ms). */
  checks: number;
  fullMs: number;
  /** Checks whose lists differed. Must stay 0. */
  mismatches: number;
  /** Of those, the ones a periodic check found and replaced with the full path's list, verifier on or off. */
  heals: number;
}

/** A view runs its full path on every query whose count is a multiple of this. */
export const VISIBILITY_HEAL_INTERVAL = 32;

let verifying = false;

/**
 * Debugging aid: every cull answered by the visibility index also runs today's full path, and each whose list differs
 * is counted (`rendererWork.visibility.<view>.mismatches`). The measured frames carry both paths' cost.
 */
export function verifyVisibilityQueries(enabled: boolean): void {
  verifying = enabled;
}

const work = new Map<VisibilityView, VisibilityViewWork>();

function workOf(view: VisibilityView): VisibilityViewWork {
  let entry = work.get(view);
  if (!entry) work.set(view, entry = { queries: 0, queryMs: 0, checks: 0, fullMs: 0, mismatches: 0, heals: 0 });
  return entry;
}

/** One culling view's schedule of checks against the full path, and its share of its kind's counts. */
export class VisibilityCheck {
  private readonly work: VisibilityViewWork;
  private count = 0;
  private periodic = false;

  constructor(view: VisibilityView) {
    this.work = workOf(view);
  }

  /** Counts a query and says whether it must also run the full path, whose result then stands. */
  due(): boolean {
    this.count++;
    this.periodic = this.count % VISIBILITY_HEAL_INTERVAL === 0;
    return this.periodic || verifying;
  }

  /** Records a query the index answered in `ms`. */
  queried(ms: number): void {
    this.work.queries++;
    this.work.queryMs += ms;
  }

  /** Records a check: whether the two lists were the same, and the time the full path took. */
  checked(same: boolean, fullMs: number): void {
    const entry = this.work;
    entry.checks++;
    entry.fullMs += fullMs;
    if (same) return;
    entry.mismatches++;
    if (this.periodic) entry.heals++;
  }
}

/** Whether two culled lists hold the same meshes in the same order. */
export function sameList<T>(a: readonly T[] | null | undefined, b: readonly T[] | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

/** Each kind of view's work so far; absent before any view culled by the index. */
export function visibilityDiagnostics(): Partial<Record<VisibilityView, VisibilityViewWork>> | undefined {
  if (work.size === 0) return undefined;
  const result: Partial<Record<VisibilityView, VisibilityViewWork>> = {};
  for (const [view, entry] of work) result[view] = { ...entry };
  return result;
}
