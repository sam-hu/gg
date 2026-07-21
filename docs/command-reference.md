# Command reference

Every command accepts `--cwd`, `--debug`, `--interactive`/`--no-interactive`, `--verify`/`--no-verify`, and `-q`/`--quiet`. `--debug` prints redacted Git command traces to stderr. Failures return exit code 1.

Unrecognized top-level commands pass through to Git, including their arguments, output, and exit code. For example, `gg add .` runs `git add .`, and `gg status --short` runs `git status --short`. Put gg global options before a passthrough command (for example, `gg --cwd ../repo status`); options after its name belong to Git and are forwarded verbatim.

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

Names, parents, selected children, and linked-worktree conflicts are validated before staging. `--insert` journals branch creation and all selected child restacks as one recoverable operation; `gg abort --force` restores the original refs, metadata, index, and worktree if a rebase conflict occurs.

The current branch is the parent unless `--onto` is supplied. With no staged changes, non-interactive mode creates an empty branch at the exact parent commit, matching the observed Graphite behavior.

## Track an existing branch

```text
gg track [branch] [-p|--parent <branch>]
```

The current branch is tracked when `branch` is omitted. The parent must already be tracked by `gg`. Without `--parent`, an interactive tracked-branch selector is shown; non-interactive use requires the flag. Tracking records the merge base between the branch and its parent, so a branch created before its parent advanced can be safely restacked afterward. Running `track` again repairs or changes the branch's metadata without checking out or rewriting the branch. Self-parenting, metadata cycles, missing branches, unrelated histories, and placing the trunk beneath another branch are rejected.

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

The default restacks the current branch's full connected stack segment. A conflict leaves a normal Git rebase in progress and prints resolution instructions. You can finish it with `gg continue` or `git rebase --continue`. After Git finishes the rebase directly, the next stack-changing `gg` command reconciles gg's metadata and resumes the saved queue before performing the new command.

## Move

```text
gg move [-o|--onto <parent>] [-s|--source <branch>] [--only] [-a|--all]
```

Without `--onto`, an interactive parent selector excludes the source and its descendants. The choices retain the tracked tree topology: independent stacks use parallel colored lanes, while branches in the same stack share a lane. Use the arrow keys to move, Enter to select, or Escape to cancel. `--only` reparents and restacks former child subtrees first, then moves the source, matching the measured 1.8.6 behavior. `--all` affects interactive selection only; because `gg` configures one active trunk, it currently adds no candidates.

## Checkout

```text
gg checkout [branch]
gg co [branch]
```

Without a branch, `co` opens the same topology-aware colored selector as `move`, including the current branch. An explicit local branch is checked out immediately; if it is not tracked by gg, the checkout still succeeds and gg reports that tracking state.

## Log

```text
gg log [short|long]
gg l [short|long]
gg ls
gg ll
```

Flags: `--classic`, `-r/--reverse`, `-s/--stack`, `-n/--steps`, `-u/--show-untracked`, `-a/--all`.

`ls` and `ll` accept the same flags as the full command. `--classic` uses the compact indentation form and ignores the other layout flags. Long mode is a decorated Git commit graph across all local branches and ignores layout flags. The default view uses colored topology lanes so sibling branches visibly fork and rejoin, and lists every commit belonging to each non-trunk branch in newest-first order. When stdin and stdout are attached to a terminal, log output opens in a full-screen ANSI-aware pager; press `q` to exit. Pipes and non-TTY callers receive plain, non-blocking output. The normal short/default view includes submitted or changed-since-submit state when recorded. `--all` is equivalent to the default while only one trunk is configured.

## Sync

```text
gg sync [--restack|--no-restack] [-f|--force] [-d|--delete-all] [-a|--all]
```

Sync fetches the trunk remote, fast-forwards local trunk when safe, optionally cleans local branches whose GitHub PRs are closed/merged at the exact current local branch SHA, and restacks every tracked root stack. Missing head SHAs and unknown PR states stop cleanup. A conflict warns, skips that subtree, and continues independent stacks.

## Merge

```text
gg merge
```

Merge finds the bottommost branch in the checked-out stack and squash-merges its open pull request into trunk through GitHub after verifying that the PR head SHA exactly matches the local branch. It then fetches and fast-forwards local trunk, deletes that same validated branch tip, reparents its direct children to trunk, and restacks every remaining descendant.

Before merging, the command renders a checkout-style tree containing the current branch's linear path down to trunk and its full descendant tree. The current branch is marked with `◉` and `(current)`. A `Y/n` confirmation directly beneath the tree names the bottommost branch and trunk; yes is the default. Merge is therefore interactive. The worktree must be clean, trunk must be fast-forwardable, and none of the affected branches may be checked out in another worktree.

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
- `-f/--force` explicitly overwrites an unexpected remote branch tip; the freshly inspected remote OID is pinned in `--force-with-lease`, so a concurrent update is still rejected
- `--always`, `--branch`, `--target-trunk`, `-s/--stack`/`--no-stack`
- `-e/--edit`, `-n/--no-edit`, title/description-specific edit flags, and `--cli`
- `-r/--reviewers`, `-t/--team-reviewers`, `--rerequest-review`
- `--comment [text]`, `-m/--merge-when-ready`
- `--ignore-out-of-sync-trunk`
- `-v/--view` and `-w/--web` (print browser instructions; they do not launch a browser)

New non-interactive PRs default to draft. Each PR targets its immediate parent; the bottom branch targets trunk or `--target-trunk`. By default, a PR title is the subject of the branch's first commit after its parent, so later commits do not replace it; explicit title editing still overrides that default. Fork workflows use the trunk's fetch remote for the base repository and Git's branch `pushRemote`/`remote.pushDefault`/branch remote precedence plus `pushurl` for the head repository.

PR descriptions are left available for human-authored content. Stack metadata is maintained in a dedicated PR comment containing a linked list of every open PR in that connected stack; the current PR is bolded. Each successful submission updates these comments in place across all tracked stacks, so upstack additions and moves are reflected on every affected PR.

An ordinary submit whose selected branches are unchanged from their last fully successful submission is a no-op and prints a single status line. Explicit actions such as `--publish`, reviewer or comment options, editing, `--always`, and browser viewing still run.
