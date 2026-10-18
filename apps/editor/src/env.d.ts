interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** RevenueCat public keys: Web Billing (web and desktop), App Store, Google Play. */
  readonly VITE_REVENUECAT_WEB_API_KEY?: string;
  readonly VITE_REVENUECAT_IOS_API_KEY?: string;
  readonly VITE_REVENUECAT_ANDROID_API_KEY?: string;
  /** RevenueCat entitlement that unlocks Haptic Pro; defaults to "pro". */
  readonly VITE_REVENUECAT_PRO_ENTITLEMENT?: string;
  /** `true` builds against `react-dom/profiling` for the editor-edit profiling harness. */
  readonly VITE_REACT_PROFILING?: string;
}
