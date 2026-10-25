// Lighting callers share the generic Engine ledger; this module re-exports its
// limit/shadow helpers under lighting names. No second ceiling or duplicate
// reservations.
export {
  availableManagedRenderBytes as availableManagedLightingBytes,
  limitManagedRenderBytes as limitManagedLightingBytes,
  reserveManagedShadowBytes,
} from "./managed-render-resources";
export type ManagedLightingResource = { handle: object; bytes: number };
