interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** Clerk Billing plan slug for Haptic Pro; defaults to "pro". */
  readonly VITE_CLERK_PRO_PLAN_SLUG?: string;
  /** `true` builds against `react-dom/profiling` for the editor-edit profiling harness. */
  readonly VITE_REACT_PROFILING?: string;
}
