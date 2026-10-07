/** Combined script + physics tick budget from engineplan §1.2 (milliseconds). */
export const TICK_BUDGET_MS = 8;

/** Play/export HUD stats channel rate so measuring does not perturb the tick. */
export const STATS_COMMAND_INTERVAL_MS = 200;

export function isTickOverBudget(
  scriptMs: number,
  physicsMs: number,
  budgetMs: number = TICK_BUDGET_MS,
): boolean {
  return scriptMs + physicsMs > budgetMs;
}

/** First sample always; then at most one stats command per interval. */
export function shouldEmitStatsCommand(
  nowMs: number,
  lastEmitMs: number | null,
  intervalMs: number = STATS_COMMAND_INTERVAL_MS,
): boolean {
  if (lastEmitMs === null) return true;
  return nowMs - lastEmitMs >= intervalMs;
}

/** Optional Stats rows enabled with `stat <group>`; FPS and tick timings always show. */
export const STAT_GROUPS = ["unit", "memory", "draws", "threads"] as const;
export type StatGroup = (typeof STAT_GROUPS)[number];

export const STAT_GROUP_LABELS: Readonly<Record<StatGroup, string>> = {
  unit: "Unit",
  memory: "Memory",
  draws: "Render",
  threads: "Threads",
};

export function isStatGroup(name: unknown): name is StatGroup {
  return typeof name === "string" && (STAT_GROUPS as readonly string[]).includes(name);
}

/** Groups after `stat <name> on|off`, in display order; unknown names change nothing. */
export function nextStatGroups(
  groups: readonly StatGroup[],
  name: unknown,
  enabled: boolean,
): readonly StatGroup[] {
  if (!isStatGroup(name)) return groups;
  return STAT_GROUPS.filter((group) => group === name ? enabled : groups.includes(group));
}
