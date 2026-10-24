/** Default encoded trace-data budget, shared by Engine Settings and the recorder. */
export const DEFAULT_TRACE_BYTE_BUDGET = 128 * 1024 * 1024;

/** How many recorded traces a project keeps by default, and at most; older ones are deleted as new ones are recorded. */
export const DEFAULT_TRACES_KEPT = 10;
export const MAX_TRACES_KEPT = 50;
