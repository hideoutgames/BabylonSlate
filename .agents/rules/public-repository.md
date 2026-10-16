# Public repository hygiene

This repository is public. Source, history, issues, pull requests and CI logs are world-readable, permanently and immediately.

## Never commit

The editor talks to a Keychain-backed secret store, signs iOS builds, and loads user projects from arbitrary folders, so sensitive material can end up in a working tree. None of it belongs in git, commit messages, PR titles or descriptions, code comments, or test fixtures:

- Credentials of any kind: API keys, tokens, passwords, session cookies, `.env` files (`.env.example` is fine with placeholders only).
- Apple signing material: `.p12`, `.cer`, `.certSigningRequest`, `.mobileprovision`, `.provisionprofile`, private keys, `ExportOptions.plist`, or any `.xcconfig` carrying a `DEVELOPMENT_TEAM` or profile UUID. Team IDs and provisioning profile UUIDs are sensitive here. Xcode build-setting variable references may be tracked when they contain no literal signing identifier; supply resolved IDs through CI configuration or ignored local files.
- Private URLs and logs: agent session links (except the one allowed in a PR description), internal dashboards, raw CI or command output, environment dumps, stack traces with absolute local paths.
- Anything belonging to a user: project files, telemetry, crash reports.

## Enforcement

1. `.gitignore` (root and `apps/editor/ios/`) keeps common offenders untracked.
2. `.github/workflows/security.yml` runs gitleaks (`.gitleaks.toml`) on the tree and new commits, with redacted findings.
3. `scripts/check-public-hygiene.mjs` (also a unit test) rejects agent session links, attribution footers, credential markers and Apple signing identifiers in tracked text, added lines, commit messages, PR titles, reviews and comments.

These are a safety net, not the rule. Don't put secrets in a public repository.

## If a secret is committed

Treat it as disclosed the moment it is pushed.

1. Revoke and rotate first. Rewriting history does not un-disclose anything.
2. Remove it from the current tree and push that fix.
3. Rewrite history only when the material cannot be rotated (a signing certificate, a user's data); coordinate with everyone holding a clone and ask GitHub Support to expire cached views.
4. Record what leaked, when it was pushed and rotated, and which layer missed it, in the fixing PR or issue. Then close that gap.

Security vulnerabilities are reported privately through GitHub's private vulnerability reporting, never in public issues.
