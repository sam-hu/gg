# Command reference

Every command accepts `--cwd`, `--debug`, `--interactive`/`--no-interactive`, `--verify`/`--no-verify`, and `-q`/`--quiet`. `--debug` prints redacted Git command traces to stderr. Failures return exit code 1.

## Initialize

```text
gg init [--trunk <branch>] [--reset]
```

Trunk inference prefers `origin/HEAD`. Without a remote default, a repository with exactly one local branch uses that branch. Ambiguous selection requires a terminal prompt or explicit `--trunk`.

## Create a branch

```text
gg branch create [name]
gg bc [name]
```

Flags: `-m/--message`, `-a/--all`, `-u/--update`, `-p/--patch`, `-i/--insert`, `-o/--onto`, `-v/--verbose`.

The current branch is the parent unless `--onto` is supplied. With no staged changes, non-interactive mode creates an empty branch at the exact parent commit, matching the observed Graphite behavior.

## Navigate

```text
gg up [steps] [-n <steps>] [--to <descendant>]
gg down [steps] [-n <steps>]
gg top
gg bottom
```

Aliases: `u`, `d`, `t`, `b`. Navigation follows metadata relationships. Multiple children require an interactive choice or `up --to`.

## Commit and amend

```text
gg commit create
gg cc
gg commit amend
gg ca
```

Common flags: `-m/--message`, `-a/--all`, `-u/--update`, `-p/--patch`, `-e/--edit`, `--reset-author`. Every successful create/amend automatically replays descendants. `--into` and `--interactive-rebase` are recognized but currently fail with an explicit unsupported error.

## Restack and recovery

```text
gg restack [--branch <branch>] [-d|--downstack] [-u|--upstack] [-o|--only]
gg r
gg continue [-a|--all]
gg abort [-f|--force]
```

The default restacks the current branch's full connected stack segment. A conflict leaves a normal Git rebase in progress and prints resolution instructions.

## Move

```text
gg move [-o|--onto <parent>] [-s|--source <branch>] [--only] [-a|--all]
```

Without `--onto`, an interactive parent selector excludes the source and its descendants. `--only` reparents and restacks former child subtrees first, then moves the source, matching the measured 1.8.6 behavior. `--all` affects interactive selection only; because `gg` configures one active trunk, it currently adds no candidates.

## Log

```text
gg log [short|long]
gg l [short|long]
gg ls
gg ll
```

Flags: `--classic`, `-r/--reverse`, `-s/--stack`, `-n/--steps`, `-u/--show-untracked`, `-a/--all`.

`ls` and `ll` accept the same flags as the full command. `--classic` uses Graphite's compact indentation form and ignores the other layout flags. Long mode is a decorated Git commit graph across all local branches and, like `gt log long`, ignores layout flags. The normal short/default view includes submitted or changed-since-submit state when recorded. `--all` is equivalent to the default while only one trunk is configured.

## Sync

```text
gg sync [--restack|--no-restack] [-f|--force] [-d|--delete-all] [-a|--all]
```

Sync fetches the trunk remote, fast-forwards local trunk when safe, optionally cleans local branches whose GitHub PRs are closed/merged, and restacks every tracked root stack. A conflict warns, skips that subtree, and continues independent stacks.

## Submit

```text
gg submit
gg s
gg submit --stack
gg ss
```

Default scope is the current branch plus downstack ancestors. `--stack` includes descendants. Core flags:

- `-d/--draft`, `-p/--publish`
- `--restack` (with `--dry-run`, the plan assumes that the announced restack will succeed)
- `--dry-run`, `-c/--confirm`, `-u/--update-only`
- `-f/--force` (authorizes a pinned force-with-lease, never raw force)
- `--always`, `--branch`, `--target-trunk`, `-s/--stack`/`--no-stack`
- `-e/--edit`, `-n/--no-edit`, title/description-specific edit flags, and `--cli`
- `-r/--reviewers`, `-t/--team-reviewers`, `--rerequest-review`
- `--comment [text]`, `-m/--merge-when-ready`
- `--ignore-out-of-sync-trunk`
- `-v/--view` and `-w/--web` (print browser instructions; they do not launch a browser)

New non-interactive PRs default to draft. Each PR targets its immediate parent; the bottom branch targets trunk or `--target-trunk`. Fork workflows use the trunk's fetch remote for the base repository and Git's branch `pushRemote`/`remote.pushDefault`/branch remote precedence plus `pushurl` for the head repository.
