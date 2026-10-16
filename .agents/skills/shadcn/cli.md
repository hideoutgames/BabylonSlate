# shadcn CLI

Run commands from the repository root with `-c apps/editor` (`--cwd`). The editor's `components.json` sends component files to `packages/ui/src/components/`. Use only the flags below; there is no `--package-manager` flag.

## `add`

```sh
npx shadcn@latest add <components...> -c apps/editor [options]
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | List the files and dependencies `add` would write, without writing anything. |
| `--diff [path]` | Show diffs between upstream and the local files (the first five, or only `path`). Implies `--dry-run`. |
| `--view [path]` | Show the upstream file contents (the first five, or only `path`). Implies `--dry-run`. |
| `-o`, `--overwrite` | Overwrite existing files. Use only with the owner's approval. |
| `-y`, `--yes` | Skip the confirmation prompt. |
| `-s`, `--silent` | Mute output. |

Do not use `--all` or `--path`.

To update an installed component from upstream:

1. `add <component> --dry-run` lists every affected file.
2. `add <component> --diff <file>` shows the change for one file.
3. Overwrite a file only when it has no local changes. Otherwise apply the upstream change by hand and keep the local edits.
4. Fix the `cn` import and dependency as described in [SKILL.md](SKILL.md#workflow).

Always compare through the CLI; do not fetch raw component files from GitHub.

## `info`

```sh
npx shadcn@latest info -c apps/editor [--json]
```

Prints the detected framework, the `components.json` aliases, the resolved paths and the installed components. Use it to confirm where files will land.

## `docs`

```sh
npx shadcn@latest docs <components...> -c apps/editor [--json]
```

Prints the documentation, example and Base UI API URLs for each component. Fetch those URLs before using an unfamiliar API.

## `diff`

Deprecated. Use `add <component> --diff [path]` instead.
