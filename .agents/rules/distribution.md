# Explicit distribution operations

Packaging, signing, uploading to TestFlight, and publishing GitHub Releases are separate distribution operations. Agents may perform them only when explicitly requested, using the requested channel and platforms. Implementation work, ordinary verification, passing CI, a merge, or a tag never grants distribution permission. A release build does not authorize App Store submission or publication.

- Use the manual distribution workflow from `main`, with an exact source commit reachable from protected `main` and successful checks for that commit.
- Test and release are distinct build actions and identities. Never promote a test Windows package by changing its prerelease flag.
- Use standard GitHub-hosted runners only. No hosted build service, larger runner, signing service, or paid storage add-on.
- Never put private prompts, session links, credentials, Apple binaries, signing logs, or tester data in public inputs, artifacts, summaries, or releases. Use a short public-safe operation description.
- Never enable public TestFlight enrollment or automate App Store submission. Release candidates use normal App Store Connect distribution and may be considered later after validation.
- Report each platform independently. Upload success does not mean tester availability. Retry Apple finalization using the exact existing version/build; do not rebuild to resolve processing delays.
- Manual dispatch and source restrictions are technical controls. GitHub cannot verify that an agent was prompted; honoring the request remains the credential holder's responsibility.

Explicit request examples:

- “Make a test build for both Windows and iPadOS from commit `<sha>`, version `<version>`.”
- “Make and publish a Windows-only release from commit `<sha>`, version `<version>`.”
- “Upload an iPadOS release candidate from commit `<sha>`, version `<version>`, to Release Candidates. Do not submit to the App Store.”

Setup, commands, and acceptance: [Distribution guide](../../docs/development/distribution.md).
