---
name: gg-stacked-branches
description: Create and manage GitHub stacked branches with the local gg CLI, including initialization, branch creation and tracking, commits, navigation, restacking, moves, sync, stacked pull-request submission, merging, and conflict recovery. Use when an agent needs to split work into dependent branches or pull requests, modify an existing branch stack, publish or update a GitHub PR stack, or respond to requests that mention gg or stacked-branch workflows.
---

# Manage Stacked Branches with gg

Use `gg` as the source of truth for stack topology. Keep each branch focused, independently testable where practical, and ordered so every branch depends only on the branch directly below it.

## Establish context

1. Verify the tool and repository before changing anything:

   ```sh
   command -v gg
   git rev-parse --show-toplevel
   git status --short
   git branch --show-current
   ```

2. Run `gg log short --stack` to inspect tracked topology. If the repository is not initialized, identify the actual trunk from repository configuration or `origin/HEAD`; do not guess when it is ambiguous.
3. Inspect existing worktree changes and keep unrelated user changes out of stack commits.
4. Treat "create a stack" as a local branch-and-commit request unless the user also asks to push, submit, or open pull requests.

Use `gg --no-interactive ...` with explicit branch, parent, message, and scope arguments when running unattended. Do not depend on terminal prompts.

## Initialize stack metadata

Initialize once with an explicit trunk:

```sh
gg --no-interactive init --trunk main
```

Replace `main` with the repository's real trunk. Do not use `gg init --reset` unless the user explicitly wants all non-trunk tracking metadata removed.

## Create a new stack

Start from the tracked branch that should be the parent. For each logical layer, make only that layer's changes, validate them, then create its child branch and commit in one operation:

```sh
gg --no-interactive branch create feature-model --all -m "Add feature model"
gg --no-interactive branch create feature-api --all -m "Add feature API"
gg --no-interactive branch create feature-ui --all -m "Add feature UI"
```

Use `--all` only when every worktree change belongs in the new commit. Otherwise stage an exact file or hunk selection first and omit `--all`:

```sh
git add path/to/file
gg --no-interactive branch create feature-api -m "Add feature API"
```

To create the branch before editing, create an empty tracked child, make the changes, then commit through gg:

```sh
gg --no-interactive branch create feature-api
# edit and validate
gg --no-interactive commit create --all -m "Add feature API"
```

Follow repository branch-naming and commit-message conventions. Never commit stack work directly to trunk.

## Attach existing branches

Track a branch created by Git or another tool with an explicit tracked parent:

```sh
gg --no-interactive track existing-branch --parent parent-branch
```

The parent must already be tracked. Prefer `gg branch create` for new work; do not create branches with raw Git and leave them untracked.

## Modify and reorganize a stack

- Create a commit and replay descendants: `gg commit create --all -m "Message"`.
- Amend the current commit and replay descendants: `gg commit amend --all`.
- Inspect the stack after every rewrite: `gg log short --stack`.
- Restack after a parent changes: `gg --no-interactive restack --branch <branch>`.
- Move a branch and its descendants: `gg --no-interactive move --source <branch> --onto <parent>`.
- Move only the source branch and reparent its former children downstack: add `--only`.
- Navigate deterministically with `gg checkout <branch>`, `gg up --to <descendant>`, `gg down`, `gg top`, or `gg bottom`.

Avoid raw `git rebase`, unleased force pushes, and manual ref deletion for tracked branches. Let gg update branch refs and stack metadata together.

## Submit pull requests

Submit only when the user authorizes remote GitHub changes. Ensure `gh` is authenticated or `GITHUB_TOKEN` is available, then inspect the exact plan:

```sh
gg log short --stack
gg --no-interactive submit --branch <branch> --stack --no-edit --dry-run
```

If the plan is correct, create or update the stack as draft pull requests:

```sh
gg --no-interactive submit --branch <branch> --stack --no-edit
```

Use `--publish` only when the user wants ready-for-review PRs. Use `--reviewers`, `--team-reviewers`, or `--comment` only when requested. Rewrites are automatic while the remote matches the last submitted version. Use `--force` only when the user explicitly intends to overwrite an unexpected remote tip; gg pins the freshly observed tip in an exact force-with-lease rather than using a raw force push. A normal unchanged submission is a no-op.

Each PR targets its immediate parent; the bottom PR targets trunk. gg maintains stack relationships in a managed PR comment while preserving human-authored descriptions.

## Recover from conflicts

An explicit `restack` or `move` conflict leaves a normal Git rebase in progress.

1. Inspect the conflict with `git status` and resolve only the intended files.
2. Stage resolved files explicitly with `git add <paths>`.
3. Run `gg continue`. Use `gg continue --all` only when every remaining change should be staged. You may instead run `git rebase --continue`; after Git finishes the rebase, the next stack-changing `gg` command adopts the result and resumes the saved queue.
4. If the operation should be abandoned, run `gg abort --force` to restore the captured refs and metadata.
5. Re-run `gg log short --stack` and the relevant tests.

Do not start another stack mutation while Git still reports a rebase in progress. Commit/amend and sync conflicts follow a warn-and-skip policy instead of leaving a rebase; inspect their output and explicitly restack any untouched descendants.

## Merge and sync cautiously

- Run `gg sync` only when fetching trunk, cleaning merged branches, and restacking all stacks is intended. It mutates local state.
- Run `gg merge` only for an explicit merge request. It interactively squash-merges the bottom PR through GitHub, updates local trunk, removes the merged local branch, and restacks descendants.

## Verify and report

Before finishing, run `git status --short`, `gg log short --stack`, and the repository's relevant checks. Report the created branch order, current branch, validation performed, and PR URLs when submitted.

Read [references/commands.md](references/commands.md) when selecting less common flags or diagnosing command behavior.
