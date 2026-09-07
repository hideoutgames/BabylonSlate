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

Published Windows releases are immutable. A conflicting tag fails before packaging. Test packages cannot become release packages by changing GitHub classification. Apple retains a single bundle identifier and app record; the channels do not install side by side.

## Rollout status

Implementation and local validation are in progress. Native acceptance has not been performed. Repository inspection found `main` unprotected and the distribution environments absent; these must be configured before dispatch can pass the trust gate. The native AppIcon is still Capacitor's placeholder. Distribution rejects it; supply an opaque 1024×1024 BabylonSlate PNG before the first Apple upload.

## Implemented paths

- `.github/workflows/distribute.yml` is manual only, with Test/Release choices, independent platforms, exact source/version assertions, and a default dry run. Only standard Ubuntu, Windows and macOS runners are used.
- Windows host and preload compile to CommonJS under `host/`; `renderer/` contains the existing editor output including the player and static/generated assets. `app://babylonslate/` restricts resource access. IPC validates the main editor frame, arguments and saved folder grants. Node integration is disabled and renderer sandboxing/context isolation remain enabled.
- `build:host`, `package:windows` and `smoke:windows` are explicit desktop scripts. The NSIS packager never publishes. A draft release is published only after installer/checksum/manifest validation. Published releases are immutable.
- `ios:sync` preserves all three custom plugins. `ios:archive` uses a Release generic-device archive, temporary credentials, normal App Store Connect export with automatic version management disabled, bundle/entitlement/privacy checks and direct Fastlane upload. No Apple binaries, signing logs or credentials become Actions artifacts.
- Ruby 3.3.12, Bundler 2.5.22, CocoaPods 1.16.2 and Fastlane 2.239.0 are locked. Distribution selects Xcode 26.6 and validates a version-26 iOS SDK. The deployment target remains separate from the SDK requirement.
- Engine Settings → About shows the generated version/channel/build/source identity. Native builds explicitly disable `VITE_TEST_MODE`.
- Finalization-only dispatches take the original source/version/channel and exact existing Apple build number; they never rebuild or upload. Pending processing fails the job with a `processing` state so it can be retried. Awaiting Beta App Review is reported as pending, not tester availability.

The app privacy manifest covers app preferences/bookmarks (`CA92.1`) and timestamps within app storage and user-selected project folders (`C617.1`, `3B52.1`). The maintainer must review SDK declarations and data handling for each intended version and explicitly classify encryption in environment configuration. No encryption exemption is assumed.
