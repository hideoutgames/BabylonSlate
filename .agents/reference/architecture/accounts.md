# Project browser and accounts

Launcher routing, optional and required sign-in, the temporary demo account, and Clerk setup for web, desktop and mobile builds.

## Launcher

- `App` retains settings and the project/document owner. `AppRoutes` loads mutually exclusive Home and Editor route modules. Play, validation, search, utility execution, and renderer hosts mount only with the Editor route.
- Haptic is dark only; there is no theme setting or toggle.
- The launcher is a sidebar (wordmark, Projects and Templates, account row) beside the library. Project cards show the chosen icon framed in the project colour, or the uploaded picture when `appearance.cover` is not `icon`; the caption shows a compact age (`31m ago`) and the Local and Source Control status.
- An empty library shows **Start Your First Project** with flat Basic 3D, Basic 2D and Blank tiles (`homepage-welcome.tsx`). Those tiles and the Templates cards open New Project at the naming step with that template chosen. The editor's first chrome tab shows the open project's icon or picture in its colour (`ProjectIdentityMark`).
- Loading is one flat splash card (wordmark, amber-to-red progress line, status and build label). The boot copy in `apps/editor/index.html` and `LauncherTransitionProvider` (`launcher-transition.css`) must stay identical; the boot page has no CSS reset, so the card sets `box-sizing` itself.
- The project browser owns its dialogs, account UI, styles, and animation lifecycle. Opening a project unmounts that entire surface, including its inline stylesheet. Returning to the browser creates fresh menu state; project state stays with `DocumentProvider`. JavaScript modules may remain in the browser's import cache.
- Opening, reconnecting, recovery, updates, and removal show operation status and keep launcher actions disabled until the operation settles. Web project options explain browser-local storage and Export Project backups.

## Accounts

- Web and Electron keep account sign-in optional, including phone-sized browser windows. Native iOS and Android require an active Clerk session or explicit **Use Temporary Demo Account** selection before the project browser mounts. Missing configuration, loading failures, and pending sessions keep project actions hidden until that selection. Demo is in-memory local testing access, not a Clerk identity: it creates no tokens or cloud entitlements, survives home/editor route changes, and ends on app restart or Profile → **End Demo**. Local projects remain in App Documents and are not deleted when demo ends. This account requirement is separate from subscription plans.
- The native account frame reserves all four viewport safe-area insets, including the top inset above its header, in every sign-in, loading, and failure state. CSS owns these insets so the iOS status bar never overlays account chrome.
- When configured on web, the launcher lazy-loads `@clerk/react` to restore the avatar. The launcher's own profile dropdown reads the user from `useUser` and calls `useClerk` for the Clerk sign-in modal (`openSignIn`), account management (`openUserProfile`), and `signOut`. The profile menu opens the **Account** dialog (Account, Subscription and Application sections) from its identity row and also lists Engine Settings and Changelog, for guest, Clerk and native accounts alike. Polling, focus-touch requests, and telemetry are disabled. Electron restores native session identity for its compact profile menu and loads the shared native email-code form when Sign In is selected, using the public Clerk Frontend API through VFS native HTTP. Mobile uses that form as its account gate. Account providers, forms, and UI unmount on entry to the editor. No Clerk dependency enters engine packages.
- The **Subscription** section lists the plans from haptic.no/pricing (Haptic free on desktop, Haptic Pro for phone and tablet, Enterprise by contact). There are no plan-based restrictions in the editor yet.

## Billing

- RevenueCat runs every subscription so entitlements stay unified: Web Billing (`@revenuecat/purchases-js`, loaded only when configured) on web and Electron, and `@revenuecat/purchases-capacitor` for the App Store and Google Play. Both sit behind the `PurchasesPort` in `@babylonslate/vfs` (`createPurchases`). Clerk handles sign-in only.
- [`subscription-billing.ts`](../../../apps/editor/src/services/subscription-billing.ts) picks `VITE_REVENUECAT_WEB_API_KEY`, `VITE_REVENUECAT_IOS_API_KEY` or `VITE_REVENUECAT_ANDROID_API_KEY` for the host and uses the Clerk user id as the RevenueCat app user id, so one Haptic Pro subscription covers every device. Signing in is required to subscribe. It buys the current offering's first package, checks the `VITE_REVENUECAT_PRO_ENTITLEMENT` entitlement (default `pro`), opens the customer's management URL for Manage Billing, and offers Restore Purchases in the mobile apps.
- Electron hands only haptic.no, Web Billing (RevenueCat and Stripe) and App Store / Google Play subscription HTTPS links and mailto to the system browser or mail client (`externalOpenUrl`), so Preview scripts cannot open arbitrary sites. Subframes load only the bundled Preview player or, outside it, Web Billing checkout from RevenueCat and Stripe over HTTPS (`isBillingFrameUrl`, `insidePreviewFrame` in `apps/desktop/src/packaged-security.ts`). Desktop checkout and RevenueCat API access from the `app://` origin still need validation with real keys.
- Without keys, purchase and management actions stay disabled and the Subscription page says subscriptions are not set up for the build. Without a signed-in account (guests and the mobile demo), billing never configures RevenueCat and asks the user to sign in.

## Account management

The Account dialog's Account section differs by host because only the web has Clerk's own account screen.

- **Web:** **Manage Account** calls `clerk.openUserProfile()`; Clerk's screen owns name, picture, connected accounts and deletion. There is no separate Delete Account entry: `@clerk/react` 6.x only offers the `@experimental` `__experimental_startPath`, and the installed types document no value for the delete page.
- **Electron, iOS, Android:** the section edits the Clerk user through `NativeClerkClient` (`updateName`, `setProfileImage`, `removeProfileImage`, `deleteAccount`) behind `NativeProfileActions`. Both session owners (`HomepageNativeAccount` for mobile, `HomepageAccount` for desktop) build them with `nativeProfileActions`, take the refreshed session back, and drop to the account gate (mobile) or guest (desktop) when the account is deleted.
  - **Name:** Clerk's first and last name. The launcher shows `name || username || email`, the order the web profile menu uses.
  - **Picture:** a hidden file input limited to PNG, JPEG, GIF and WEBP up to 10 MB (Clerk's limit), which also runs in iOS WKWebView and Android WebView. `imageUrl` is kept only when the user's `has_image` is true, as on web. Returning from the picker fires window focus, whose foreground check hides the app on mobile and would unmount the input before its change event, so the mobile gate skips that check from the Upload Picture click until the upload settles, the pick is cancelled or the section closes (`holdSessionCheck`).
  - **Delete Account:** offered only when the user's `delete_self_enabled` is true, behind a destructive `AlertDialog` that says local projects on the device are not deleted. Success clears the stored client token in the same serialized step. App Store guideline 5.1.1(v) requires in-app account deletion for apps that let people create accounts; that is why native deletion exists.
- **Frontend API** (mirrors `@clerk/clerk-js` `User.update`, `User.setProfileImage`, `Image.create/delete` and `User.delete`). `PATCH` and `DELETE` go out as `POST` with `_method`, as clerk-js sends them, so native HTTP stays GET/POST. `/me` calls add `_clerk_session_id`; each change is followed by `GET /v1/client` to read the user back.

| Action | Request |
| --- | --- |
| Name | `POST /v1/me?_method=PATCH`, form body `first_name`, `last_name` |
| Upload picture | `POST /v1/me/profile_image`, multipart part `file` |
| Remove picture | `POST /v1/me/profile_image?_method=DELETE` |
| Delete account | `POST /v1/me?_method=DELETE` |

- **Upload transport:** `NativeHttpRequest.upload` carries one base64 image part and no `Content-Type`. Capacitor passes it to the iOS and Android form-data encoders (`dataType: "formData"`, a `base64File` entry, `Content-Type: multipart/form-data` without a boundary, which both natives then set). Electron builds the multipart body in the main process (`encodeMultipartImage`); `validateIpcArguments` accepts it only for a POST without `body`, a plain field and file name, an image type and bounded base64. The picked file's own name never leaves the device.
- **Errors:** unknown server errors read as `account_update_failed` or `account_delete_failed`, never as a sign-in failure. Name and picture rejections have their own messages. `session_reverification_required` tells the user to sign in again, because the native client has no reverification flow.
- **Not covered:** connected accounts (system-browser OAuth), email or password changes, and signed-in device management stay web-only.

## Clerk configuration

Create a Clerk application, copy `apps/editor/.env.example` to `apps/editor/.env.local`, and set `VITE_CLERK_PUBLISHABLE_KEY` to its publishable key. Restart Vite after changes. Never expose a Clerk secret key through Vite. See Clerk's [React quickstart](https://clerk.com/docs/react/getting-started/quickstart) and [provider options](https://clerk.com/docs/react/reference/components/clerk-provider).

Distribution builds read the key from the repository variable `VITE_CLERK_PUBLISHABLE_KEY` (see [Distribution maintainer setup](../distribution.md#maintainer-setup)). Without it, packaged desktop builds are guest-only and Android/iPadOS builds offer only the temporary demo account.

Dashboard settings account management depends on (nothing is provisioned by the repository):

- **First and last name** under User & authentication, for name editing on every host.
- **Allow users to delete their accounts**, for deletion on every host. Without it `delete_self_enabled` is false and the native Delete Account entry is hidden.
- **Social connections** for the web's connected accounts; the native apps do not manage them yet.

Web sign-in, sign-up, and account settings use Clerk-managed modal UI; redirect fallbacks honor Vite's deployment base. Configure the Clerk application for the deployed web origin. No account or key is provisioned by the repository. Local projects do not become cloud-synced by signing in.

For Electron and native iOS/Android, enable **Native API** in the Clerk dashboard's Native applications page. Enable email addresses for sign-in and sign-up, **Sign-in with email code**, and email verification codes at sign-up. Use email-only registration without other required profile fields, passwords, or MFA; the native flow handles email codes and refuses authenticated access when additional verification or session tasks remain. Desktop guests can still create and open projects. See Clerk's [email-code configuration](https://clerk.com/docs/guides/development/custom-flows/authentication/email-sms-otp) and [native-client terminology](https://clerk.com/docs/guides/development/sdk-development/terminology).

[`apps/editor/src/services/native-clerk.ts`](../../../apps/editor/src/services/native-clerk.ts) serializes public Frontend API requests with native-client headers, reads the rotating client token from response headers, and stores it through `SecretStore`. iOS uses Keychain, and Android uses the `BabylonSlateSecrets` plugin's AndroidKeyStore-encrypted store. Electron's `app://babylonslate` renderer uses native HTTP and a dedicated account store: OS-encrypted persistence when available, otherwise process memory; restarting a process-memory session requires sign-in again. No client token is persisted in local storage or project data. The native form supports email-code sign-in/sign-up, resend, restoration, and sign-out. Profile editing and deletion are in [Account management](#account-management). It does not implement system-browser OAuth, so connecting GitHub, Discord or Apple is web-only until that exists.

New and restored sessions must appear active in Clerk's response. While the account UI is mounted, window focus or foreground visibility revalidates a signed-in session; mobile project actions stay hidden until that check succeeds. These listeners and forms unmount on entering the editor (desktop sign-in forms also unmount when their modal closes). Authentication failure never gates desktop project access. The configured Clerk application and actual desktop/mobile host transport still require end-to-end validation before distribution, including the profile calls and the multipart picture upload on iOS, Android and Electron; unit tests exercise controlled external HTTP/storage boundaries.
