/** Combined script + physics tick budget from engineplan §1.2 (milliseconds). */
export const TICK_BUDGET_MS = 8;

export function isTickOverBudget(
  scriptMs: number,
  physicsMs: number,
  budgetMs: number = TICK_BUDGET_MS,
): boolean {
  return scriptMs + physicsMs > budgetMs;
}
