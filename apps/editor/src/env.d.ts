interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** `true` in iOS and Android development builds synced with `--demo`: no sign-in. */
  readonly VITE_MOBILE_DEMO?: string;
  /** RevenueCat public keys: Web Billing (web and desktop), App Store, Google Play. */
  readonly VITE_REVENUECAT_WEB_API_KEY?: string;
  readonly VITE_REVENUECAT_IOS_API_KEY?: string;
  readonly VITE_REVENUECAT_ANDROID_API_KEY?: string;
  /** RevenueCat entitlement that unlocks Haptic Pro; defaults to "pro". */
  readonly VITE_REVENUECAT_PRO_ENTITLEMENT?: string;
  /** Public client ids of the GitHub OAuth App and gitlab.com application that Source Control signs in with. */
  readonly VITE_GITHUB_CLIENT_ID?: string;
  readonly VITE_GITLAB_CLIENT_ID?: string;
  /** `true` builds against `react-dom/profiling` for the editor-edit profiling harness. */
  readonly VITE_REACT_PROFILING?: string;
}
