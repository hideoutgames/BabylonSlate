# Explicit distribution operations

Packaging, signing, uploading to TestFlight and publishing GitHub Releases happen only when the user explicitly asks, for the channel and platforms they name, for example "Make a test build for Windows and iPadOS from commit `<sha>`, version `<version>`." Implementation, verification, passing CI, a merge or a tag never grants permission, and a release build never authorizes App Store submission.

- Run the manual distribution workflow from `main`, for an exact commit reachable from protected `main` whose checks passed.
- Test and release are distinct builds and identities; never promote a test package by changing its prerelease flag.
- Never put private prompts, credentials, Apple binaries, signing logs or tester data in public inputs, artifacts, summaries or releases.
- Never enable public TestFlight enrollment or automate App Store submission.
- Report each platform separately; an upload is not tester availability. Retry Apple finalization with the exact existing version and build instead of rebuilding.

Setup, commands and recovery: [distribution reference](../reference/distribution.md).
