# Distribution

How Haptic desktop and mobile builds are versioned, signed, uploaded and published through the manual `distribute.yml` workflow, plus setup, dispatch commands and recovery. Agents act on this only after an explicit request ([rule](../rules/distribution.md)).

## Guards

- Distribution is explicitly invoked and separate from ordinary build, Verify, Preview and merge. Test and release builds have different identities. Neither channel submits to the App Store; there is no public TestFlight enrollment.
- Standard GitHub-hosted runners only (Ubuntu, Windows, macOS). All logs, summaries, caches and GitHub artifacts are public: never put credentials, session links, Apple binaries, signing logs or tester data in inputs, artifacts, summaries or releases. Secret masking alone is insufficient; sensitive commands clean up on success and failure (a timed-out or cancelled Apple stage stops every process it started; a keychain that cannot be deleted fails cleanup).
- Never provide credentials in chat, issues, workflow inputs or commits; provision them in GitHub environment settings.
- Never move a tag, never promote a Test package by flipping its prerelease flag, never rerun publication for an already-published GitHub Release or replace its assets, never substitute an unverified package after artifact expiry (artifacts live one day).
- Do not add native packaging to recursive workspace `build` or to ordinary Verify. Do not add Apple ID passwords or unverified signing modes. No icon or splash art may be generated. Platform icons and splash screens are the human-made marks in `engine-logos/`, scaled and centred on Haptic's warm black (`#0b0a08`); regenerate them the same way when the marks change.
- Report each platform independently. Dispatch acceptance is not build success; upload success is not tester availability. Never report a partially successful request as complete.

## Version contract

- The dispatch `version` must match `release/version.json` at the selected source commit. Actions never commit generated counters. `appleSequenceOffset` in that file offsets the run number; audit it if the workflow is renamed or recreated.
- `packageVersion` (desktop package version and Android `versionName`) is `<version>-indev.<run>.<attempt>` for Test and `<version>-release` for Release.
- `androidVersionCode = sequence * 1000 + channelCode * 100 + attempt` (sequence = run number + Apple offset; channel 0 Test, 1 Release).
- Apple keeps numeric marketing versions and `<sequence>.<channel-code>.<attempt>` build numbers. Sequence is 1-9999, attempt 1-99, counters never wrap; a duplicate or superseded build needs a fresh dispatch.
- Windows, macOS, Linux and Android share one GitHub Release and tag per `packageVersion`; requested assets publish together or not at all. Desktop/Android jobs keep the validate job's attempt, so rerunning only failed jobs yields one tag/version; iPadOS uses its actual job attempt (every Apple upload needs a unique build number).

| Identity | Test | Release |
| --- | --- | --- |
| Package version | `0.0.1-indev.417.1` | `0.0.1-release` |
| Tag | `v0.0.1-indev.417.1` | `v0.0.1-release` |
| GitHub classification | Prerelease, never Latest | Normal; GitHub's legacy version/date selection for Latest |
| Apple marketing / build | `0.0.1` / `417.0.1` | `0.0.1` / `418.1.1` |
| Android versionCode | `417001` | `418101` |
| Private TestFlight group | Test Builds | Release Candidates |

Vite reads the generated manifest for startup, project-loading and Engine Settings identity; a manifest with another application version is rejected. Published GitHub Releases are immutable: conflicting tags or drafts targeting another source fail before packaging. Apple keeps one bundle identifier and app record, so channels do not install side by side.

## Changelog rule

- Release notes are written in `release/changelog.json` and embedded in every build; the app makes no network request for them.
- Every `release/version.json` bump adds an entry: numeric `version`, nonempty `title`, nonempty `changes` array of single-line plain-text notes. Keep older entries as the source history. Notes are public release content. Vite and `scripts/distribution/changelog.test.mjs` reject a declared version without notes; entries newer than the declared version are left out until the bump, so notes can be drafted ahead.
- Distribution preflight reads the declared version's entry from the exact source commit for both channels into the build manifest, and Vite embeds that copy (`__HAPTIC_RELEASE_NOTES__`, read by `apps/editor/src/lib/changelog.ts`); other builds embed the working tree's entry. Each GitHub Release body also starts with the notes as written by `patchNotesMarkdown`, for the release page only; editing them on GitHub does not change installed apps.
- The launcher shows **What's New** with the running version's changes once its loading screen has gone. Both it and the profile menu's **Changelog** are a fixed-size window titled with the build name (`Release X.Y.Z`, `Test X.Y.Z`, or `Development X.Y.Z` without a manifest) over a scrolling change list; the entry's `title` appears only in the GitHub Release body. News shows until that version's first dismissal (remembered in local Engine Settings `seenReleaseVersions`; browser profiles and devices keep separate histories). A launch with no seen version (a fresh install, or cleared app settings) records the running version without announcing it, so news appears only after an update. The profile menu's **Changelog** shows the same notes again, offline included. Dev servers and explicit QA `?test` sessions omit automatic news.

## Desktop automatic updates

- Windows checks `latest.yml`; Linux checks `latest-linux.yml` only when launched as an AppImage (`APPIMAGE` set); signed/notarized macOS checks `latest-mac.yml`. Unsigned macOS packages disable updates (Squirrel.Mac rejects unsigned updates).
- Checks run at startup and every six hours; downloads are background-only and install on normal exit. Test builds, unpackaged hosts, unsigned macOS and unpacked Linux executables do not check. Clients reject prereleases and downgrades.
- **Engine Settings → About → Automatic Updates** defaults on; off stops checks, cancels downloads and disables install-on-exit. Windows session end defers install to a later normal exit.
- Every feed is checked against package name, size and SHA-512 before staging; publication verifies each platform allowlist and SHA-256 checksums. Installations without the updater need one manual install.

## Readiness without secrets

Every platform builds from a clean checkout without credentials; only signing, notarization and store upload wait for secrets.

| Platform | Works without secrets | Needs provisioning |
| --- | --- | --- |
| Windows | Unsigned x64 NSIS installer: packaged, installed and smoked (**Inspect desktop packaging**); publishable | Nothing (no code signing configured) |
| macOS | Unsigned arm64/x64 DMG and ZIP: packaged, mounted, smoked; publishable with updates disabled | Developer ID signing and notarization (`macos-signing`) |
| Linux | x64 AppImage: packaged, extracted, smoked under Xvfb; publishable | Nothing |
| Android | Debug APK via `android:build` (**Inspect Android toolchain**) | Signed release APK and publication (`android-signing`) |
| iPadOS | Unsigned iPad simulator build via `ios:build` (**Inspect Apple toolchain** `ipados-build` job) | Archive, signing, TestFlight upload (`testflight`) |

`platforms=all` or `mobile` dispatches fail the Android and iPadOS jobs until their environments are provisioned; `desktop` needs no secrets. Create all four environments with branch restrictions before the first dispatch, even while empty. The iOS AppIcon and the desktop `apps/desktop/build/icon.png` are `engine-logos/HapticAppIcon.png` (opaque 1024x1024); distribution still rejects the Capacitor placeholder (kept as a test fixture in `scripts/distribution/fixtures/`). The iOS and Android display names are **Haptic** (the Apple contract checks `CFBundleDisplayName`); the App Store Connect record and Play listing names are changed in the stores, and the bundle identifier stays `no.hideout.babylonslate`.

## Implemented paths

- [`.github/workflows/distribute.yml`](../../.github/workflows/distribute.yml) is manual only: `channel` (test/release), `platforms` (`all`, `desktop`, `mobile`, `ipados`, `android`, `windows`, `macos`, `linux`), `source_sha`, `version`, `dry_run` (default true), `operation` (`distribute` / `finalize-testflight`), `existing_build_number`. It runs from `main` only, with one active operation at a time (a pending request can be replaced; inspect queued/cancelled states). The independent TestFlight finalization and GitHub publication jobs install locked dependencies before touching credentials or artifacts, with package lifecycle scripts disabled; finalization never rebuilds native binaries.
- **Electron host** ([`apps/desktop`](../../apps/desktop/)): host/preload compile to CommonJS under `host/`; the packaged `renderer/`, `app://babylonslate/` protocol, IPC validation, sandboxing and context isolation are shared by all desktop hosts. Subframes may load only the bundled `player/` page; the only web permission granted is clipboard writing from the editor frame. User libraries reach only allowlisted `userData/libraries/<folder>` scopes through file-only `library:*` IPC; folder grants, Engine Settings and secret files are replaced atomically. Staging drops web/deployment placeholder markers (`.nojekyll`, `.keep`, `.gitkeep`) but still rejects other dotfiles, symlinks and credential-shaped files. Packaging refuses an existing `dist/app`, `dist/installers` or `dist/public`; the installed-app smoke fails unless the package manifest's source is the checked-out commit. Scripts: `package:<windows|macos|linux>`, `smoke:<...>`, `build:host`.
- **Windows** jobs set `MSYS2_ENV_CONV_EXCL=VITE_BASE_PATH` so Git Bash does not rewrite the `/` base; packaging rejects a renderer whose entry script is not under `/assets/`. Windows may warn about an unrecognized publisher.
- **macOS** builds arm64/x64 DMG + ZIP with hardened-runtime entitlements; without the p12 secret packaging is unsigned, updates are disabled, and users open it via **Privacy & Security → Open Anyway**. **Linux** builds an x64 AppImage.
- **Android** (scripts in [`apps/editor/package.json`](../../apps/editor/package.json)): `android:sync` builds/copies the web app and refreshes Capacitor wiring (fails unless the native web copy matches fresh `dist`, because `cap sync` logs a failed copy yet exits 0); `android:build` compiles a debug APK; `android:release` assembles the signed universal APK. Gradle receives `babylonslateVersionCode` / `babylonslateVersionName`; signing comes only from temporary `BABYLONSLATE_ANDROID_*` properties. Publication verifies the signature with `apksigner`, rejects the debug certificate and checks package/version with `aapt2`. The Gradle wrapper pins `distributionSha256Sum` for `gradle-8.14.3-all.zip`; update it with the URL.
- **iPadOS**: `ios:sync` preserves the custom Capacitor plugins and fails unless the native web copy matches fresh `dist` and the Podfile keeps its App target and `post_install` deployment-target hook. `ios:archive` requires all four custom plugin registrations, imports the manual signing assets, creates a signed Release generic-device archive preserving requested entitlements, then does a normal App Store Connect export (automatic version management disabled), bundle/entitlement/privacy checks and a direct Fastlane upload with temporary credentials. The manual profile selector applies only to the App target (Pod frameworks get no app profile); the Xcode project holds a variable reference, never a profile id, and public-hygiene checks reject literal signing identifiers. No Apple binaries, signing logs or credentials become Actions artifacts.
- **Toolchain pins**: Ruby 3.3.12 (`.ruby-version`), Bundler 2.5.22, CocoaPods 1.16.2, Fastlane 2.239.0 (`Gemfile.lock`), Xcode 26.6 build 17F113 with iPhoneOS SDK 26.5 (`scripts/distribution/apple-toolchain.mjs`; any other build fails before credential import and needs a toolchain review). The iOS/iPadOS deployment target is 17.0 in the Xcode project and Podfile, independent of the SDK requirement. Every workflow reads Node from `.node-version`, so a distribution source commit must contain it; all actions are pinned to full commit SHAs with a `# vX.Y.Z` comment (update both together).
- `publish-release` validates every requested platform package, manifest identity, updater feed and checksum before merging toolchains, `platformsBuilt`, optional `macosSigned`, one manifest and one regenerated checksum file; conflicting toolchain versions or any missing platform block publication.
- Engine Settings → About shows the generated version/channel/build/source identity. Native builds disable `VITE_TEST_MODE`. Only a distribution build (`BABYLONSLATE_DISTRIBUTION=true`, which refuses test-mode storage) keeps `build-manifest.json` in its output; desktop packaging, `android:release` and `ios:archive` require it in the bundle they package (for iPadOS byte-identical to the generated identity), so a test-mode or development bundle cannot be signed.
- **Finalization-only** dispatches take the original source/version/channel and the exact existing Apple build number; they never rebuild or upload and never create a GitHub Release. The App Store Connect record must match the bundle identifier before metadata or group membership changes. Pending processing fails the job with a `processing` state so it can be retried; Awaiting Beta App Review is reported as pending, not tester availability.
- Inspection workflows (no secrets, no uploads): `inspect-desktop-packaging.yml` (`gh workflow run inspect-desktop-packaging.yml --ref <branch> -f platform=all -f channel=test`), `inspect-android-toolchain.yml` (`gh workflow run inspect-android-toolchain.yml --ref <branch>`; Java 21, Gradle 8.14.3), `inspect-apple-toolchain.yml` (`gh workflow run inspect-apple-toolchain.yml --ref main`; validates Xcode/SDK with `node scripts/distribution/apple-toolchain.mjs --inspect-xcode`, checks plists with `plutil`, reads public `xcodebuild -help` on standard `macos-26`; a separate `ipados-build` job runs the locked Pods and `ios:build` with `CODE_SIGNING_ALLOWED=NO` and confirms `Podfile.lock` is unchanged). They verify toolchain, plist syntax and that the shell compiles; they cannot certify provisioning, signing permissions or TestFlight delivery.

## iOS native shell

- UIKit scene-based lifecycle (Capacitor 8 template): `Info.plist` declares `UIApplicationSceneManifest` (single scene, `Main` storyboard, `SceneDelegate`), `SceneDelegate` owns the `CAPBridgeViewController` window and forwards URL/universal-link opens to `SceneDelegateProxy`, `AppDelegate` returns the scene configuration. iOS 26+ SDKs refuse apps with only the legacy window path.
- The App target requests `increased-memory-limit` and `extended-virtual-addressing` (Debug and Release; no fixed RAM guarantee; virtual address space is not physical memory) and Push Notifications (`aps-environment` = `development` for Debug, `production` for Release and both TestFlight channels; this enables signing only, with no permission request, token registration or provider). Not requested: Associated Domains (leave disabled on the App ID), iCloud/CloudKit, App Groups, shared Keychain groups. The provisioning profile and exported IPA must keep both memory entitlements and production push before upload. After enabling capabilities for `no.hideout.babylonslate`, regenerate the App Store profile and replace `APPLE_PROVISIONING_PROFILE_BASE64`; no new secret is needed. These entitlements apply to the native host only; WebKit content processes get no assumed extra memory.
- The app targets iPhone and iPad (device family 1,2; iPhone portrait + both landscapes, iPad landscape-only and full screen: `UIRequiresFullScreen` opts out of multitasking, without which App Store Connect rejects the upload; Apple deprecated the key in iPadOS 26, so a future SDK may require every iPad orientation) with native storage, orientation and audio lifecycle integration. The privacy manifest covers app preferences/bookmarks (`CA92.1`) and timestamps in app storage and user-selected project folders (`C617.1`, `3B52.1`); the maintainer reviews SDK declarations per version and explicitly classifies encryption (`APPLE_USES_NON_EXEMPT_ENCRYPTION`); never declare an exemption to silence a warning.
- No paid infrastructure is added: TestFlight needs the existing Apple Developer Program membership; runners are free standard hosted runners; no notification service is configured.

## Maintainer setup

1. Protect `main` with required checks. Distribution requires the latest successful Verify run for the exact selected commit (static, unit and all four browser shards) plus configured branch/ruleset checks; a passing ancestor or skipped draft run does not qualify.
2. Create environments `testflight`, `github-release`, `macos-signing` and `android-signing`. For each, choose **Selected branches and tags**, add a branch rule for exactly `main`, allow no tags or other branches. Do not use **Protected branches only** (it can allow all branches when protection is absent).
3. Create the App Store Connect app record for `no.hideout.babylonslate` with private groups **Test Builds** and **Release Candidates**: public links and automatic access to every build disabled, explicit membership only. Existing App Store Connect users may test internally; others get private invitations; external testing can require Beta App Review; builds expire after 90 days.
4. Provision directly in the `testflight` environment:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `APPLE_DISTRIBUTION_P12_BASE64` | Base64 Apple Distribution certificate **and private key** (`.p12`) |
| Secret | `APPLE_DISTRIBUTION_PASSWORD` | Password for that `.p12` |
| Secret | `APPLE_PROVISIONING_PROFILE_BASE64` | Base64 App Store provisioning profile for this app/team |
| Secret | `ASC_PRIVATE_KEY_P8_BASE64` | Base64 App Store Connect API private key |
| Variable | `ASC_KEY_ID` | API key identifier |
| Variable | `ASC_ISSUER_ID` | Team key issuer UUID; leave unset for a supported individual key |
| Variable | `ASC_APP_ID` | Numeric App Store Connect app ID |
| Variable | `APPLE_TEAM_ID` | Ten-character Apple team ID |
| Variable | `APPLE_BUNDLE_ID` | `no.hideout.babylonslate` |
| Variable | `APPLE_TEST_GROUP_ID` | UUID of Test Builds |
| Variable | `APPLE_RELEASE_GROUP_ID` | UUID of Release Candidates |
| Variable | `APPLE_PRIVACY_REVIEWED_VERSION` | Numeric version whose app/SDK privacy declarations were reviewed |
| Variable | `APPLE_USES_NON_EXEMPT_ENCRYPTION` | Explicit `true`/`false` after reviewing encryption use and export compliance |

This is the complete iPadOS Apple configuration: four secrets, nine variables (`ASC_ISSUER_ID` optional only for an individual key). For upload and finalization the minimum documented API role is **App Manager** (Developer can upload but not manage build info/testers); no Admin key is required. Keep the Apple App ID, app record, agreements, beta contact/review info, privacy declarations and encryption documentation current.

`macos-signing`: secrets `APPLE_DEVELOPER_ID_P12_BASE64`, `APPLE_DEVELOPER_ID_PASSWORD`, `ASC_PRIVATE_KEY_P8_BASE64`; variables `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`. The macOS job intentionally runs unsigned when `APPLE_DEVELOPER_ID_P12_BASE64` is absent; if signing is enabled every other value is required and failures name only the missing variable.

`android-signing` secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Android has no unsigned distribution mode (the release script fails clearly without the keystore). GitHub Release publication uses only the built-in `GITHUB_TOKEN`; no PAT.

Repository **variable** (not secret) `VITE_CLERK_PUBLISHABLE_KEY` (Settings → Secrets and variables → Actions → Variables) is passed to every platform's editor build; it is a public key embedded in the bundle. Builds do not fail when it is unset but then have no Clerk sign-in (desktop stays guest-only; Android/iPadOS offer only **Use Temporary Demo Account**). Clerk dashboard setup is in [Clerk configuration](architecture/accounts.md#clerk-configuration).

Optional repository variables `VITE_REVENUECAT_WEB_API_KEY` (Windows, macOS, Linux), `VITE_REVENUECAT_ANDROID_API_KEY` (Android), `VITE_REVENUECAT_IOS_API_KEY` (iPadOS) and `VITE_REVENUECAT_PRO_ENTITLEMENT` (all) configure RevenueCat subscriptions; they are public keys embedded in the bundle. Without them the Subscription page shows purchases as not set up. See [Billing](architecture/accounts.md#billing). The iOS Podfile lists `RevenuecatPurchasesCapacitor`; run `pnpm --filter editor ios:sync` on a Mac to install it and refresh `Podfile.lock`.

**Automatic Apple provisioning is not enabled.** The target of a single `ASC_PRIVATE_KEY_P8_BASE64` secret with automatic signing has not passed qualification; the manual signer and its three signing secrets stay in use. Do not add an automatic-mode selector, transplant Xcode Cloud build flags, create/revoke certificates per run or silently provision an Admin key. The API key authenticates requests but does not supply the signing private key, and no supported unsigned/ad-hoc archive route for cloud signing was established. Provisioning endpoints need a **team** API key (created by a human Admin/Account Holder; team keys cover every app on the team, so app-ID checks do not narrow their authority), and the minimum role for cloud signing is unverified. Switching requires an Apple-supported archive procedure plus two successful fresh hosted macOS runs with no prior Apple login, certificates or signing cache, covering certificate lifecycle, immutable identity, private group delivery, signature/entitlements, privacy/encryption and failure cleanup.

## Invoking an authorized operation

Use only after an explicit request naming channel and platforms. `SOURCE_SHA` is the exact 40-character commit on protected `main` with the asserted checked-in version; omitted source uses the dispatch commit. A dry run validates source/checks/versions/destinations without a native build or Apple authentication, so it certifies neither signing credentials nor TestFlight availability.

```sh
# Read-only preflight for every platform.
gh workflow run distribute.yml --ref main -f channel=test -f platforms=all -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=true

# Explicitly requested desktop test distribution.
gh workflow run distribute.yml --ref main -f channel=test -f platforms=desktop -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=false

# Explicitly requested unsigned Windows release.
gh workflow run distribute.yml --ref main -f channel=release -f platforms=windows -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=false

# Explicitly requested iPadOS release candidate; no App Store submission.
gh workflow run distribute.yml --ref main -f channel=release -f platforms=ipados -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=false

# Finalize an existing upload (original channel/source/version and exact Apple build).
gh workflow run distribute.yml --ref main -f operation=finalize-testflight -f channel=test -f platforms=ipados -f source_sha=SOURCE_SHA -f version=0.0.1 -f existing_build_number=417.0.1 -F dry_run=false
```

Find the run in Actions and preserve its run ID, source and per-platform manifest identity. For a combined operation rerun failed jobs so every desktop/Android package keeps the validate identity. A Test prerelease may publish while Apple is unavailable (overall result stays partial); a normal combined Release requires Apple availability or reported pending beta review.

## Operations and recovery

| Outcome | Recovery |
| --- | --- |
| Invalid source, version, missing checks or conflicting tag | Correct the request or complete exact-source checks; dispatch again. Never move a tag. |
| Missing credentials, signing failure, icon/privacy rejection | Fix environment/assets or compliance configuration; inspect the sanitized stage result. Do not publish private logs to diagnose it. |
| Duplicate/superseded Apple number | Fresh dispatch. Audit offsets if the workflow was renamed/recreated; never wrap counters. |
| Upload failed with uncertain outcome | Check App Store Connect for the exact version/build before retrying; an upload error does not mean Apple received nothing. The log prints Apple's response: up to six `ITMS-` or error lines, with team, key, issuer and app IDs, emails, UUIDs, absolute paths and token-like strings redacted (`scripts/distribution/apple-upload-errors.mjs`); everything else stays private. |
| Uploaded, still processing, finalization API failure | Retry only finalization against the original identity (command above). Do not archive/upload again. A failed finalization prints its reason: the script's own message or the App Store Connect status code, never a response body. |
| Awaiting Beta App Review | Complete beta review/contact/compliance details privately in App Store Connect, then retry finalization (separate from App Store submission). |
| One desktop/Android job failed | Rerun failed jobs; the shared validate identity keeps one tag/version and publication waits for every requested GitHub Release platform. Preserve successful artifacts. |
| Unsigned macOS package | Expected when the p12 secret is absent: updates stay disabled, open via **Privacy & Security → Open Anyway**. Provision all `macos-signing` values to get signing/notarization. |
| iPadOS failed or still processing | Normal combined Release publication is blocked. Complete Apple finalization, then rerun the original failed finalization/publication jobs. |
| Only one platform succeeds | Report partial success and its exact identity; never the overall request as complete. |
| GitHub Release already published | Inspect the published identity; do not rerun publication or replace assets. A new Test dispatch gets a distinct version; a new Release needs a version change. |

Public asset allowlist: Windows x64 `.exe` plus release `latest.yml`/`.blockmap`; macOS arm64+x64 `.dmg` and `.zip` plus release `latest-mac.yml`; Linux x64 `.AppImage` plus release `latest-linux.yml`; Android universal `.apk`; one merged `SHA256SUMS.txt` and `build-manifest.json`. Apple IPAs, archives, keychains, profiles, raw diagnostics and tester exports stay off GitHub.
