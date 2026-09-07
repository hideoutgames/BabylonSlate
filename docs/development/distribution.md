# Distribution

Distribution is explicitly invoked and separate from ordinary build, Verify, Preview, and merge operations. Test and release builds have different identities. Neither channel submits to the App Store.

## Version contract

The version declared at the selected source commit is the intended application version. The dispatch version must match it. Generated counters are never committed by Actions.

| Identity | Test | Release |
| --- | --- | --- |
| Windows | `0.0.1-indev.417.1` | `0.0.1-release` |
| Tag | `v0.0.1-indev.417.1` | `v0.0.1-release` |
| Release title | `[TEST] BabylonSlate …` | `[RELEASE] BabylonSlate …` |
| GitHub classification | Prerelease, never Latest | Normal; GitHub legacy version/date selection for Latest |
| Apple marketing version | `0.0.1` | `0.0.1` |
| Apple build | `417.0.1` | `418.1.1` |
| Private TestFlight group | Test Builds | Release Candidates |
| App Store selection policy | Do not select | May be considered after validation |

The initial numeric version is `0.0.1`, declared in `release/version.json`. Windows uses the requested `-indev` and `-release` suffixes; Apple marketing versions remain numeric. GitHub classification is explicit regardless of SemVer suffix. Apple uses `<sequence>.<channel-code>.<attempt>`: workflow run number plus an explicitly configured initial offset, channel 0 or 1, and the actual build job's run attempt. Sequence is 1–9999 and attempt 1–99. Counters never wrap. Before replacing or renaming the workflow, audit existing uploads and configure an offset that preserves ordering. Duplicate or superseded builds require a fresh dispatch. See [Apple's numeric component limits](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html).

Published Windows releases are immutable. A conflicting tag or a draft targeting anything other than the exact selected source fails before packaging. Test packages cannot become release packages by changing GitHub classification. Apple retains a single bundle identifier and app record; the channels do not install side by side.

## Rollout status

The implementation provides the manual distribution paths below. On September 7, 2026, `testflight` and `github-release` were configured with exact-`main` branch restrictions, and `main` was protected with all nine Verify checks, including enforcement for administrators. Native acceptance has not been performed; Apple credentials and compliance configuration still require maintainer provisioning. The native AppIcon is still Capacitor's placeholder. Distribution rejects it; supply an opaque 1024×1024 BabylonSlate PNG before the first Apple upload.

## Implemented paths

- `.github/workflows/distribute.yml` is manual only, with Test/Release choices, independent platforms, exact source/version assertions, and a default dry run. Only standard Ubuntu, Windows and macOS runners are used.
- Windows host and preload compile to CommonJS under `host/`; `renderer/` contains the existing editor output including the player and static/generated assets. `app://babylonslate/` restricts resource access. IPC validates the main editor frame, arguments and saved folder grants. Node integration is disabled and renderer sandboxing/context isolation remain enabled.
- `build:host`, `package:windows` and `smoke:windows` are explicit desktop scripts. The NSIS packager never publishes. A draft release is published only after installer/checksum/manifest validation. Published releases are immutable.
- `ios:sync` preserves all three custom plugins. `ios:archive` uses a Release generic-device archive, temporary credentials, normal App Store Connect export with automatic version management disabled, bundle/entitlement/privacy checks and direct Fastlane upload. No Apple binaries, signing logs or credentials become Actions artifacts.
- Ruby 3.3.12, Bundler 2.5.22, CocoaPods 1.16.2 and Fastlane 2.239.0 are locked. Distribution selects Xcode 26.6 and validates a version-26 iOS SDK. The deployment target remains separate from the SDK requirement.
- Engine Settings → About shows the generated version/channel/build/source identity. Native builds explicitly disable `VITE_TEST_MODE`.
- Finalization-only dispatches take the original source/version/channel and exact existing Apple build number; they never rebuild or upload. Pending processing fails the job with a `processing` state so it can be retried. Awaiting Beta App Review is reported as pending, not tester availability.

The app privacy manifest covers app preferences/bookmarks (`CA92.1`) and timestamps within app storage and user-selected project folders (`C617.1`, `3B52.1`). The maintainer must review SDK declarations and data handling for each intended version and explicitly classify encryption in environment configuration. No encryption exemption is assumed.

## Maintainer setup

1. Protect `main` with required checks. Distribution requires the latest successful Verify run for the exact selected commit, including static, unit and all seven browser shards, plus configured branch/ruleset checks. A passing ancestor or skipped draft run does not qualify.
2. Create GitHub environments named `testflight` and `github-release`. For each, select **Selected branches and tags**, add a **branch** rule for exactly `main`, and allow no tags or other branches. Do not use **Protected branches only**, which can allow all branches when protection is absent. Required reviewers are optional; this workflow does not require a second human approval.
3. Create the App Store Connect app record for `no.hideout.babylonslate`. Create **Test Builds** and **Release Candidates** under that app. Disable public links and automatic access to every build in all groups; use explicit membership. Existing App Store Connect users may test internally; other testers receive private invitations. External testing can require Beta App Review and builds expire after 90 days.
4. Provision the following values directly in GitHub's `testflight` environment settings. Never provide credentials in chat, issues, workflow inputs or commits.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `APPLE_DISTRIBUTION_P12_BASE64` | Base64 Apple Distribution certificate **and private key** exported as `.p12` |
| Secret | `APPLE_DISTRIBUTION_PASSWORD` | Password protecting that `.p12` |
| Secret | `APPLE_PROVISIONING_PROFILE_BASE64` | Base64 App Store provisioning profile for this app/team |
| Secret | `ASC_PRIVATE_KEY_P8_BASE64` | Base64 App Store Connect API private key |
| Variable | `ASC_KEY_ID` | API key identifier |
| Variable | `ASC_ISSUER_ID` | Team key issuer UUID; leave unset for a supported individual key |
| Variable | `ASC_APP_ID` | Numeric App Store Connect app ID |
| Variable | `APPLE_TEAM_ID` | Ten-character Apple team ID |
| Variable | `APPLE_BUNDLE_ID` | `no.hideout.babylonslate` |
| Variable | `APPLE_TEST_GROUP_ID` | UUID of Test Builds |
| Variable | `APPLE_RELEASE_GROUP_ID` | UUID of Release Candidates |
| Variable | `APPLE_PRIVACY_REVIEWED_VERSION` | Numeric version whose app/SDK privacy declarations have been reviewed |
| Variable | `APPLE_USES_NON_EXEMPT_ENCRYPTION` | Explicit `true` or `false` after reviewing actual encryption use and export-compliance requirements |

Signing and API authentication are separate credentials. Choose the least-privileged API identity that supports both upload and finalization: Developer can upload, while build-information/tester management can require App Manager or Admin. Evaluate an individual key against the required operations and tooling; team keys apply across apps and must not be described as app-scoped. Do not default to an Account Holder identity. The Windows environment uses only the built-in `GITHUB_TOKEN`; no stored PAT is needed.

Before the first Apple upload, replace the Capacitor placeholder with an existing, human-supplied opaque 1024×1024 app icon, review privacy manifests for the app and embedded SDKs, and complete any necessary encryption documentation in App Store Connect. Do not declare an exemption just to suppress a warning. The app remains iPad-only and retains native storage, orientation and audio lifecycle integration.

Review the pinned standard runner's installed Xcode before toolchain upgrades. Xcode/SDK requirements are independent of the deployment target. Install dependencies with `pnpm install --frozen-lockfile` and the checked-in Ruby bundle; keep CocoaPods and its lockfile. Do not add native packaging to recursive workspace `build` or ordinary Verify.

## Invoking an authorized operation

Only use these commands after an explicit request for the stated channel and platforms. Replace `SOURCE_SHA` with the exact 40-character source on protected `main` and assert its checked-in version. The workflow definition always runs from `main`; omitted source uses the dispatch commit. A dry run validates source/checks/versions/destinations without a native build or Apple authentication, so it does not certify signing credentials or TestFlight availability.

```sh
# Read-only preflight for a proposed test build.
gh workflow run distribute.yml --ref main -f channel=test -f platforms=both -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=true

# Explicitly requested test distribution to both destinations.
gh workflow run distribute.yml --ref main -f channel=test -f platforms=both -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=false

# Explicitly requested unsigned Windows release.
gh workflow run distribute.yml --ref main -f channel=release -f platforms=windows -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=false

# Explicitly requested iPadOS release candidate; no App Store submission.
gh workflow run distribute.yml --ref main -f channel=release -f platforms=ipados -f source_sha=SOURCE_SHA -f version=0.0.1 -F dry_run=false
```

Find the resulting run in Actions and preserve its run ID, source and per-platform manifest identity. Dispatch acceptance is not build success. Concurrency permits one active operation and does not interrupt it, but GitHub can replace a pending request; inspect queued/cancelled states rather than assuming every dispatch will execute.

## Operations and recovery

| Outcome | Recovery |
| --- | --- |
| Invalid source, version, missing checks or conflicting tag | Correct the request or complete exact-source checks; dispatch again. Never move a tag. |
| Missing credentials, signing failure, icon/privacy rejection | Fix environment/assets or compliance configuration; inspect the sanitized stage result. Do not publish private logs to diagnose it. |
| Duplicate/superseded Apple number | Make a fresh dispatch. Audit offsets if the workflow was renamed/recreated; never wrap counters. |
| Upload failed with an uncertain outcome | Check App Store Connect for the exact version/build before retrying. Do not assume an upload error means Apple received nothing. |
| Uploaded, still processing, finalization API failure | Retry only finalization against the original identity using the command below. Do not archive/upload again. |
| Awaiting Beta App Review | Complete required beta review/contact/compliance details privately in App Store Connect, then retry finalization. This is separate from App Store submission. |
| Interrupted Windows asset upload | Rerun failed jobs while the original Windows artifact remains. Matching draft assets are reused; different/unexpected assets fail without replacement. |
| Both requested; Apple failed or is still processing | Normal Windows publication is blocked. Preserve the packaged Windows identity; complete Apple finalization and rerun the original failed finalization/publication jobs. |
| Only one platform succeeds | Report partial success and its exact identity. Never report the overall request complete. |
| Windows release already published | Inspect the published identity; do not rerun publication or replace assets. A new test dispatch gets a distinct version; a new release needs a version change. |

```sh
# Use the original channel/source/version and exact existing Apple build.
gh workflow run distribute.yml --ref main -f operation=finalize-testflight -f channel=test -f platforms=ipados -f source_sha=SOURCE_SHA -f version=0.0.1 -f existing_build_number=417.0.1 -F dry_run=false
```

A finalization-only dispatch never creates a Windows release. For a combined operation, once Apple is ready, rerun the original failed jobs to retain the original Windows manifest/artifact rather than generating a different package. Artifacts are retained for one day; if they expire before recovery, do not substitute an unverified package. Preserve any draft and its identity for maintainer inspection and make a fresh authorized request as appropriate. A Windows prerelease may be published with an Apple failure, but the overall result remains partial; a normal combined release requires Apple availability or a reported pending beta review.

All logs, summaries, caches and GitHub artifacts must be treated as public. Only the Windows installer, `SHA256SUMS.txt` and `build-manifest.json` are uploaded. Apple IPAs, archives, keychains, profiles, raw diagnostics and tester exports stay off GitHub. Sensitive commands write private temporary diagnostics and cleanup runs on failure as well as success. Secret masking alone is insufficient; this cannot protect against malicious trusted code, compromised dependencies or compromised credential holders.

## Acceptance record

Do not mark rollout complete until each applicable item has recorded evidence. Ordinary verification does not package or distribute a native app.

- [ ] Full local `pnpm verify` and current-head PR Verify pass; ordinary CI includes distribution contract/security tests without native jobs.
- [ ] Both environments have exact-main branch restrictions, `main` is protected, and credentials/configuration are provisioned by the maintainer.
- [ ] Dry runs reject invalid inputs, untrusted source, conflicting tags and missing/pending/skipped/cancelled checks, with no build/sign/upload/publication side effects.
- [ ] An explicitly requested Windows build installs and launches with clean user data and no repository/dev server dependency. About shows the expected identity; project creation, scene/graph editing, storage/relaunch, Play/Stop, player, workers and WebAssembly work. Package contents contain no developer projects or credentials.
- [ ] Windows test publication is a prerelease and leaves Latest unchanged; installer/checksum/manifest match. Release-channel publication has its own `-release` identity and is unsigned.
- [ ] An explicitly requested iPadOS build installs through the selected private TestFlight group on a real iPad. Confirm identity, iPad-only targeting, storage/plugins and persistence, scene/graph editing, Play/Stop, audio and workers.
- [ ] A release candidate used normal App Store Connect export, retained its production app name and is identifiable for later selection. No App Store submission occurred.
- [ ] Invalid/missing credentials, signing failure, duplicate builds, delayed processing and interrupted publication were exercised; sanitized logs and cleanup were reviewed, and independent finalization recovered an existing upload.
- [ ] Inspect Actions artifacts and Releases for both successful and failed operations: no Apple packages, credentials, raw signing/upload diagnostics or tester data were exposed.

Native builds and real-device acceptance are still pending. A green workflow/configuration test alone does not satisfy these items.

## References

- [GitHub manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), [release API](https://docs.github.com/en/rest/releases/releases), [environment restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) and [security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).
- [Standard hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [macOS 26 image toolchain](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md).
- [Capacitor 8 toolchain requirements](https://capacitorjs.com/docs/updating/8-0), [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview) and [Fastlane pilot](https://docs.fastlane.tools/actions/pilot/).
- [Electron custom protocols](https://www.electronjs.org/docs/latest/api/protocol) and [security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
