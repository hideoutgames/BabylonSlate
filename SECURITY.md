# Security policy

BabylonSlate is a **public** repository. Everything in it — source, history, issues,
pull requests, CI logs — is world-readable, permanently and immediately.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/hideoutgames/BabylonSlate/security/advisories/new).
Do not open a public issue, and do not include working exploit payloads or real
credentials in the report.

Expect an acknowledgement within a few days. There is no bug bounty.

## What must never be committed

The editor talks to a Keychain-backed secret store, signs iOS builds, and loads
user projects from arbitrary folders, so several classes of sensitive material can
plausibly end up in a working tree. None of it belongs in git:

- Credentials of any kind: API keys, tokens, passwords, session cookies, `.env`
  files (`.env.example` is fine — it must contain only placeholders).
- Apple signing material: `.p12`, `.cer`, `.certSigningRequest`,
  `.mobileprovision`, `.provisionprofile`, private keys, `ExportOptions.plist`,
  or any `.xcconfig` carrying a `DEVELOPMENT_TEAM` or profile UUID. Team IDs and
  provisioning profile UUIDs are treated as sensitive here: they identify the
  developer account and are not needed to build for the simulator.
- Private URLs and logs: links to agent sessions (Devin, Cursor, or otherwise),
  internal dashboards, raw CI or command output, environment dumps, stack traces
  containing absolute local paths.
- Anything belonging to a user: project files, telemetry, crash reports.

The same applies to commit messages, PR titles and descriptions, code comments,
and test fixtures.

## How this is enforced

Three layers, all of which run on Linux and need no macOS or Xcode:

1. `.gitignore` (root and `apps/editor/ios/`) keeps the common offenders
   untrackable in the first place.
2. `.github/workflows/security.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks)
   against the working tree and the pull request's commits, configured by
   `.gitleaks.toml`. Findings are redacted in the log — a public CI log must not
   become the leak.
3. `scripts/check-public-hygiene.mjs` (also run as a unit test, so `pnpm verify`
   covers it) rejects agent session links and credential markers in tracked
   content and in a pull request's added lines.

None of these can catch a secret that has been renamed and obfuscated. They are a
safety net under the actual rule, which is human: don't put secrets in a public
repo.

## If a secret is committed

Treat it as disclosed the moment it is pushed, whether or not anyone noticed.

1. **Revoke and rotate first.** Rewriting history does not un-disclose anything —
   forks, clones, CI caches, and GitHub's own unreachable-commit views may retain
   it. Rotation is the only real remedy, and it comes before cleanup.
2. Remove the secret from the current tree and push that fix, so the working
   state is clean while the rest proceeds.
3. Decide whether to rewrite history. For a secret that has been rotated, usually
   don't: a force-push over `main` breaks every open branch and clone for a
   cosmetic gain. Rewrite only when the material cannot be rotated (a signing
   certificate, a customer's data) — coordinate it with everyone holding a clone,
   and ask GitHub Support to expire the old cached views.
4. Record the incident in the pull request or issue that fixed it: what leaked,
   when it was pushed, when it was rotated, and which layer above missed it. Then
   close the gap that missed it.
