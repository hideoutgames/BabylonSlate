/**
 * P4 multi-transport harness helpers.
 * The in-process runtime is the source of truth; SAB/transferable hosts must
 * produce identical world state for the same seed and tick count.
 */
export { createInProcessRuntime } from "@babylonslate/runtime";
