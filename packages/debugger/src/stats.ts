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
