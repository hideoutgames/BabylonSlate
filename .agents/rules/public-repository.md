# Public repository hygiene

This repository is public. Source, history, issues, pull requests and CI logs are world-readable, permanently and immediately.

## Never commit

None of these belong in git, commit messages, PR titles or descriptions, comments, code or test fixtures:

- Credentials of any kind: API keys, tokens, passwords, session cookies, `.env` files (`.env.example` with placeholders only).
- Apple signing material: `.p12`, `.cer`, `.certSigningRequest`, `.mobileprovision`, `.provisionprofile`, private keys, `ExportOptions.plist` and `.xcconfig` files. Team IDs and provisioning profile UUIDs are sensitive; tracked Xcode settings may hold only variable references, with the resolved values in CI configuration or ignored local files.
- Agent session links and lines crediting an agent or a requester, internal dashboards, raw CI or command output, environment dumps, and stack traces with absolute local paths.
- Anything belonging to a user: project files, telemetry, crash reports.

## Enforcement

`.gitignore` keeps common offenders untracked; gitleaks (`security.yml`) and `scripts/check-public-hygiene.mjs` (with its unit test) reject credentials, Apple signing identifiers and paths, agent session links and attribution in tracked files, added lines, commit messages and every part of a pull request. They are a safety net, not the rule.

## If a secret is committed

Treat it as disclosed the moment it is pushed.

1. Revoke and rotate first; rewriting history does not un-disclose anything.
2. Remove it from the current tree and push that fix.
3. Rewrite history only when the material cannot be rotated (a signing certificate, a user's data); coordinate with everyone holding a clone and ask GitHub Support to expire cached views.
4. In the fixing PR or issue, record what leaked, when, and which layer missed it, then close that gap.

Report security vulnerabilities through GitHub's private vulnerability reporting, never in public issues.
