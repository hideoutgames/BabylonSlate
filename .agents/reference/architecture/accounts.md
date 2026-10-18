# Project browser and accounts

Launcher routing, optional and required sign-in, the temporary demo account, and Clerk setup for web, desktop and mobile builds.

## Launcher

- `App` retains settings, theme, and the project/document owner. `AppRoutes` loads mutually exclusive Home and Editor route modules. Play, validation, search, utility execution, and renderer hosts mount only with the Editor route.
- Haptic is dark only; there is no theme setting or toggle.
- The launcher is a sidebar (wordmark, Projects and Templates, account row) beside the library. Project cards show the chosen icon framed in the project colour, or the uploaded picture when `appearance.cover` is not `icon`; the caption shows a compact age (`31m ago`) and the Local and Source Control status.
- The project browser owns its dialogs, account UI, styles, and animation lifecycle. Opening a project unmounts that entire surface, including its inline stylesheet. Returning to the browser creates fresh menu state; project state stays with `DocumentProvider`. JavaScript modules may remain in the browser's import cache.
- Opening, reconnecting, recovery, updates, and removal show operation status and keep launcher actions disabled until the operation settles. Web project options explain browser-local storage and Export Project backups.

## Accounts

- Web and Electron keep account sign-in optional, including phone-sized browser windows. Native iOS and Android require an active Clerk session or explicit **Use Temporary Demo Account** selection before the project browser mounts. Missing configuration, loading failures, and pending sessions keep project actions hidden until that selection. Demo is in-memory local testing access, not a Clerk identity: it creates no tokens or cloud entitlements, survives home/editor route changes, and ends on app restart or Profile → **End Demo**. Local projects remain in App Documents and are not deleted when demo ends. This account requirement is separate from subscription plans.
- The native account frame reserves all four viewport safe-area insets, including the top inset above its header, in every sign-in, loading, and failure state. CSS owns these insets so the iOS status bar never overlays account chrome.
- When configured on web, the launcher lazy-loads `@clerk/react` to restore the avatar. The launcher's own profile dropdown reads the user from `useUser` and calls `useClerk` for the Clerk sign-in modal (`openSignIn`), account management (`openUserProfile`), and `signOut`. The profile menu opens the **Account** dialog (Account, Subscription and Application sections) from its identity row and also lists Engine Settings and Changelog, for guest, Clerk and native accounts alike. Polling, focus-touch requests, and telemetry are disabled. Electron restores native session identity for its compact profile menu and loads the shared native email-code form when Sign In is selected, using the public Clerk Frontend API through VFS native HTTP. Mobile uses that form as its account gate. Account providers, forms, and UI unmount on entry to the editor. No Clerk dependency enters engine packages.
- The **Subscription** section lists the plans from haptic.no/pricing (Haptic free on desktop, Haptic Pro for phone and tablet, Enterprise by contact). There are no plan-based restrictions in the editor yet.

## Billing

- Web and desktop use Clerk Billing: `useSubscription` and `usePlans` from `@clerk/react/experimental` give the current plan, `CheckoutButton` subscribes to the plan whose slug is `VITE_CLERK_PRO_PLAN_SLUG` (default `pro`), and `SubscriptionDetailsButton` manages billing. Enable Billing in the Clerk dashboard and create that plan.
- iOS and Android use RevenueCat through `@revenuecat/purchases-capacitor`, behind the `StorePurchasesPort` in `@babylonslate/vfs` (`createStorePurchases`). [`store-billing.ts`](../../../apps/editor/src/services/store-billing.ts) configures it with `VITE_REVENUECAT_IOS_API_KEY` or `VITE_REVENUECAT_ANDROID_API_KEY`, identifies purchases with the Clerk user id so one subscription covers every device, buys the current offering's first package, checks the `VITE_REVENUECAT_PRO_ENTITLEMENT` entitlement (default `pro`), restores purchases and opens the store's management URL.
- Without keys, purchase and management actions stay disabled and the Subscription page says billing is not connected for the build.

## Clerk configuration

Create a Clerk application, copy `apps/editor/.env.example` to `apps/editor/.env.local`, and set `VITE_CLERK_PUBLISHABLE_KEY` to its publishable key. Restart Vite after changes. Never expose a Clerk secret key through Vite. See Clerk's [React quickstart](https://clerk.com/docs/react/getting-started/quickstart) and [provider options](https://clerk.com/docs/react/reference/components/clerk-provider).

Distribution builds read the key from the repository variable `VITE_CLERK_PUBLISHABLE_KEY` (see [Distribution maintainer setup](../distribution.md#maintainer-setup)). Without it, packaged desktop builds are guest-only and Android/iPadOS builds offer only the temporary demo account.

Web sign-in, sign-up, and account settings use Clerk-managed modal UI; redirect fallbacks honor Vite's deployment base. Configure the Clerk application for the deployed web origin. No account or key is provisioned by the repository. Local projects do not become cloud-synced by signing in.

For Electron and native iOS/Android, enable **Native API** in the Clerk dashboard's Native applications page. Enable email addresses for sign-in and sign-up, **Sign-in with email code**, and email verification codes at sign-up. Use email-only registration without other required profile fields, passwords, or MFA; the native flow handles email codes and refuses authenticated access when additional verification or session tasks remain. Desktop guests can still create and open projects. See Clerk's [email-code configuration](https://clerk.com/docs/guides/development/custom-flows/authentication/email-sms-otp) and [native-client terminology](https://clerk.com/docs/guides/development/sdk-development/terminology).

[`apps/editor/src/services/native-clerk.ts`](../../../apps/editor/src/services/native-clerk.ts) serializes public Frontend API requests with native-client headers, reads the rotating client token from response headers, and stores it through `SecretStore`. iOS uses Keychain, and Android uses the `BabylonSlateSecrets` plugin's AndroidKeyStore-encrypted store. Electron's `app://babylonslate` renderer uses native HTTP and a dedicated account store: OS-encrypted persistence when available, otherwise process memory; restarting a process-memory session requires sign-in again. No client token is persisted in local storage or project data. The native form supports email-code sign-in/sign-up, resend, restoration, and sign-out; it does not implement system-browser OAuth or account management.

New and restored sessions must appear active in Clerk's response. While the account UI is mounted, window focus or foreground visibility revalidates a signed-in session; mobile project actions stay hidden until that check succeeds. These listeners and forms unmount on entering the editor (desktop sign-in forms also unmount when their modal closes). Authentication failure never gates desktop project access. The configured Clerk application and actual desktop/mobile host transport still require end-to-end validation before distribution; unit tests exercise controlled external HTTP/storage boundaries.
