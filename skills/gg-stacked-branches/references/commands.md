# gg command reference

Use this reference for command selection and exact scope. Prefer explicit, non-interactive arguments in automation.

- [Global behavior](#global-behavior)
- [Initialize and track](#initialize-and-track)
- [Commit](#commit)
- [Navigate and inspect](#navigate-and-inspect)
- [Restack, move, and recover](#restack-move-and-recover)
- [Sync](#sync)
- [Submit](#submit)
- [Merge](#merge)

## Global behavior

Every command accepts `--cwd <path>`, `--debug`, `--interactive` or `--no-interactive`, `--verify` or `--no-verify`, and `--quiet`. Put global flags before the command for predictable parsing.

Unknown top-level commands pass through to Git. For example, `gg status --short` runs `git status --short`. Prefer an explicit `git` command when clarity matters.

## Commands

### Initialize and track

```text
gg init [--trunk <branch>] [--reset]
gg branch create [name] [-m <message>] [--all|--update|--patch] [--insert] [--onto <parent>]
gg bc [name] ...
gg track [branch] --parent <tracked-parent>
```

- `init` stores the selected trunk and stack metadata in the repository's common Git directory.
- `branch create` makes a tracked child of the current branch unless `--onto` is supplied. With no staged changes it creates an empty branch at the parent commit.
- `--insert` places the new branch between its parent and selected children.
- Re-running `track` repairs or changes metadata without checking out or rewriting the branch.

### Commit

```text
gg commit create [-m <message>] [--all|--update|--patch] [--edit]
gg cc ...
gg commit amend [-m <message>] [--all|--update|--patch] [--edit]
gg ca ...
```

Successful create and amend operations replay descendants automatically. `--into` and `--interactive-rebase` are recognized but unsupported.

### Navigate and inspect

```text
gg checkout [branch]       # alias: co
gg up [steps] [--to <descendant>]
gg down [steps]
gg top
gg bottom
gg log [short|long] [--stack] [--reverse] [--steps <n>] [--show-untracked]
gg ls                      # log short
gg ll                      # log long
```

Use explicit branches or `--to` when topology offers multiple choices. Default log output shows tracked lanes and every commit belonging to each branch. `--stack` limits output to the current stack.

### Restack, move, and recover

```text
gg restack [--branch <branch>] [--downstack|--upstack|--only]
gg r ...
gg move --source <branch> --onto <parent> [--only]
gg continue [--all]
gg abort --force
```

- Default restack scope is the current branch's connected stack segment.
- `--downstack` includes ancestors, `--upstack` includes descendants, and `--only` selects only the named branch.
- Default move scope moves the source and its descendants. `move --only` reparents former children downstack before moving the source.
- Explicit restack and move use durable operation state and can be continued or aborted after a conflict.

### Sync

```text
gg sync [--restack|--no-restack] [--force] [--delete-all] [--all]
```

Sync fetches trunk, fast-forwards it when safe, optionally cleans branches with closed or merged PRs, and restacks tracked root stacks. `--force` replaces a diverged local trunk only after validation. `--delete-all` deletes every eligible merged or closed PR branch.

### Submit

```text
gg submit [--branch <branch>] [--stack|--no-stack] [--draft|--publish]
          [--restack] [--dry-run|--confirm] [--no-edit]
          [--reviewers <users>] [--team-reviewers <teams>]
          [--comment [text]] [--merge-when-ready] [--always]
gg s ...
gg ss ...                 # submit --stack
```

- Default scope is the selected branch plus downstack ancestors. `--stack` also includes descendants.
- New non-interactive PRs default to draft.
- `--dry-run` prints the plan without pushing or mutating PRs.
- `--confirm` prints and prompts on the complete plan.
- `--no-edit` suppresses PR-field prompts. `--publish` publishes draft PRs.
- Rewritten branches use an automatic pinned force-with-lease. The compatibility `--force` flag is deprecated.
- Explicit actions such as publish, reviewers, comments, editing, `--always`, or viewing bypass the unchanged-stack no-op.

### Merge

```text
gg merge
```

Merge selects the bottommost PR in the current stack, renders the affected topology, and asks for confirmation. It squash-merges through GitHub, fetches trunk, deletes the merged local branch, reparents direct children, and restacks descendants. It requires a clean worktree and a fast-forwardable trunk.
