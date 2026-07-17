# Graphite 1.8.6 compatibility

Reference behavior was researched against the locally installed Graphite CLI `gt 1.8.6` on 2026-07-16. Automated differential checks are optional; the normal suite does not require Graphite. `gg` now uses an independent `.gg_*` metadata namespace, so compatibility refers to workflow behavior rather than shared repository files.

## Command mapping

| `gg` canonical command             | `gt 1.8.6` behavioral reference                                   | Status                                |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `gg init`                          | `gt init`                                                         | Implemented                           |
| `gg branch create`, `gg bc`        | hidden/deprecated `gt branch create`, `gt bc`; modern `gt create` | Implemented                           |
| `gg track`                         | `gt track`                                                        | Implemented for one branch at a time  |
| `gg up/down/top/bottom`            | same                                                              | Implemented                           |
| `gg commit create`, `gg cc`        | hidden/deprecated forms; equivalent to `gt modify -c`             | Implemented                           |
| `gg commit amend`, `gg ca`         | hidden/deprecated forms; equivalent to `gt modify`                | Implemented                           |
| `gg restack`, `gg r`               | same                                                              | Implemented                           |
| `gg log`, `gg l`, `gg ls`, `gg ll` | same aliases                                                      | Implemented, approximate presentation |
| `gg sync`                          | `gt sync`                                                         | GitHub-native implementation          |
| `gg move`                          | same                                                              | Implemented                           |
| `gg submit`, `gg s`, `gg ss`       | `gt submit`, aliases                                              | GitHub-native implementation          |
| `gg continue`, `gg abort`          | same recovery workflow                                            | Implemented                           |

The legacy branch/commit groups still execute in `gt 1.8.6`, but Graphite hides them from root help and prints rename warnings. They are deliberately canonical in `gg`, as required, and do not print deprecation warnings.

## Behavioral matrix

| Area            | Compatible behavior                                                                                                                   | Deliberate or current difference                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Metadata        | Equivalent branch graph, trunk JSON, PR cache data, modes, and legacy-ref import                                                      | Files use the independent `.gg_*` namespace; `.gg_operation_state` adds rollback data                     |
| Initialization  | Explicit/inferred trunk, reinitialization, zero-branch failure, reset                                                                 | Interactive text is close rather than byte-for-byte                                                       |
| Branch creation | durable parent, empty branch, staging flags, generated names, insert ordering                                                         | Insert is applied child-by-child rather than as one abortable multi-child transaction                     |
| Branch tracking | current or named existing branch, explicit or interactive parent, merge-base recording, metadata repair, cycle rejection              | Recursive tracking and `--force` ancestor inference are not currently implemented                         |
| Navigation      | metadata-based movement, clamped steps, ambiguity handling, hints                                                                     | Decorative output is simplified                                                                           |
| Commit          | create/amend, staging, message/edit options, descendant replay, warn-only conflict                                                    | `--into` and `--interactive-rebase` are explicitly unsupported                                            |
| Restack         | stored-base replay, empty commits, dirty tolerance for non-current branches, conflict halt/continue/abort, cross-worktree journal     | Merge commits fall back to normal rebase conflict handling                                                |
| Move            | cycle/self rejection, source/onto, descendants, measured children-first `--only`                                                      | Cycle errors exit 1 instead of gt's observed exit-0 bug; clean current-branch moves use safe replay/reset |
| Log             | all stacks, current marker, restack/submission state, classic/short/long modes, untracked branches                                    | Lane art and age layout are readable approximations                                                       |
| Sync            | fetch, safe trunk FF/divergence, all-stack restack, PR-state cleanup, warn-and-skip conflicts                                         | Graphite backend replaced by GitHub; `--all` currently operates on the active trunk only                  |
| Submit          | downstack/stack scope, fork bases/heads, draft/publish, idempotent update, reviewers, comments, rerequest, auto-merge, dry run, lease | Plan lines are original; `--view`/`--web` print instructions instead of launching Graphite/GitHub UI      |
| Force push      | automatic pinned force-with-lease; never raw force; exact remote OID is checked                                                       | A concurrent remote update safely rejects the lease                                                       |

## Sanctioned omissions

- Graphite web application, dashboard, telemetry, upgrade prompts, and backend configuration.
- AI-generated branches or PR text (`--ai`/`--no-ai`).
- Proprietary Graphite API calls.

## Single-trunk flags

The 1.8.6 `--all` flags expose branches across multiple configured trunks. `gg` deliberately manages one active trunk, so `log --all`, `sync --all`, and `move --all` are accepted but do not widen scope beyond that trunk.

## Observed bugs intentionally not reproduced

- Moving a branch onto its descendant prints two errors but exits 0 in `gt 1.8.6`; `gg` rejects it with exit 1.
- `gt move` can write the new parent before a failed rebase; `gg` journals the intended parent and commits it only after replay succeeds.

## Additional empirical correction

`gt 1.8.6` creates `.gtlocalprinfo` in addition to the files documented in the original research notes. `gg` stores the equivalent worktree-local cache in `.gg_local_pr_info` with two-space JSON and `0600` mode.
