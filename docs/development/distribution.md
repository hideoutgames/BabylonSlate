# Distribution

Distribution is explicitly invoked and separate from ordinary build, Verify, Preview, and merge operations. Test and release builds have different identities. Neither channel submits to the App Store.

## Version contract

The version declared at the selected source commit is the intended application version. The dispatch version must match it. Generated counters are never committed by Actions.

| Identity | Test | Release |
| --- | --- | --- |
| Windows | `1.2.3-test.417.1` | `1.2.3` |
| Tag | `v1.2.3-test.417.1` | `v1.2.3` |
| Release title | `[TEST] BabylonSlate …` | `[RELEASE] BabylonSlate …` |
| GitHub classification | Prerelease, never Latest | Normal; GitHub legacy version/date selection for Latest |
| Apple marketing version | `1.2.3` | `1.2.3` |
| Apple build | `417.0.1` | `418.1.1` |
| Private TestFlight group | Test Builds | Release Candidates |
| App Store selection policy | Do not select | May be considered after validation |

Examples are illustrative. Apple uses `<sequence>.<channel-code>.<attempt>`: workflow run number plus an explicitly configured initial offset, channel 0 or 1, and the actual build job's run attempt. Sequence is 1–9999 and attempt 1–99. Counters never wrap. Before replacing or renaming the workflow, audit existing uploads and configure an offset that preserves ordering. Duplicate or superseded builds require a fresh dispatch. See [Apple's numeric component limits](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html).

Published Windows releases are immutable. A conflicting tag fails before packaging. Test packages cannot become release packages by changing GitHub classification. Apple retains a single bundle identifier and app record; the channels do not install side by side.

## Rollout status

Implementation is in progress. Native acceptance has not been performed. Repository inspection found `main` unprotected and the distribution environments absent; these must be configured before dispatch can pass the trust gate.
