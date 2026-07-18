# Metadata format

`gg` stores stack state in its own `.gg_*` namespace. Its schema was informed by Graphite CLI 1.8.6 during the original compatibility research, but the two tools do not share repository metadata files.

## Files

Git has a shared common directory for refs/configuration and a separate Git directory for each linked worktree. `gg` resolves both with `git rev-parse` rather than assuming `.git` is a directory.

| Base directory   | Path                         |   Mode | Purpose                                                               |
| ---------------- | ---------------------------- | -----: | --------------------------------------------------------------------- |
| common Git dir   | `.gg_metadata.db`            | `0644` | SQLite branch graph and migration records                             |
| common Git dir   | `.gg_repo_config`            | `0600` | Trunk configuration                                                   |
| common Git dir   | `.gg_pr_info`                | `0600` | PR cache                                                              |
| common Git dir   | `.gg_mutation_lock`          | `0600` | Process-owned lease serializing all repository mutations              |
| common Git dir   | `.gg_mutation_lock.recovery` | `0600` | Transient guard serializing stale-lease recovery                      |
| common Git dir   | `.gg_operation_state`        | `0600` | Exclusive cross-worktree rollback/restart journal while an op is live |
| worktree Git dir | `.gg_local_pr_info`          | `0600` | Worktree-local PR cache                                               |
| worktree Git dir | `.gg_continue`               | `0600` | Continuation hint for the owning worktree                             |

JSON files are written through a same-directory temporary file followed by `rename`, and SQLite mutations use `BEGIN IMMEDIATE` transactions.

## Repository configuration

Fresh initialization writes two-space JSON without a final newline:

```json
{
  "trunk": "main",
  "trunks": [
    {
      "name": "main"
    }
  ]
}
```

The PR cache files begin as:

```json
{
  "prInfos": [],
  "mergeabilityStatuses": []
}
```

```json
{
  "localPrInfo": []
}
```

The common PR cache is created during initialization. A worktree-local cache is created the first time `gg` opens initialized metadata from that worktree.

## Exact SQLite schema

```sql
CREATE TABLE "kysely_migration" (
  "name" varchar(255) not null primary key,
  "timestamp" varchar(255) not null
);

CREATE TABLE "kysely_migration_lock" (
  "id" varchar(255) not null primary key,
  "is_locked" integer default 0 not null
);

CREATE TABLE "branch_metadata" (
  "branch_name" text not null primary key,
  "parent_branch_name" text,
  "parent_branch_revision" text,
  "last_submitted_version" text,
  "last_submitted_base_branch" text,
  "state" text,
  "sibling_order" integer not null,
  "branch_revision" text,
  "validation_result" text,
  "parent_head_revision" text
);

CREATE INDEX "idx_branch_metadata_parent"
  on "branch_metadata" ("parent_branch_name");
```

The required migration rows, in order, are:

```text
20260211_initial_schema
20260212_add_validation_columns
20260220_add_parent_head_revision
20260717_normalize_graph_topology
20260717_record_submitted_base_branch
```

Each migration runs inside a write transaction and is recorded only after its schema change succeeds. Its timestamp is the current ISO UTC time at that point. The lock table contains `migration_lock | 0`.

## Branch fields

- `branch_name`: local branch name and primary key.
- `parent_branch_name`: durable direct parent, or `NULL` for trunk.
- `parent_branch_revision`: base commit on which this branch's commits currently sit. `gg track` initializes it to the selected branches' merge base.
- `parent_head_revision`: the parent's head at the last metadata refresh.
- `branch_revision`: current local branch tip at the last refresh.
- `sibling_order`: stable ordering among branches with the same parent.
- `validation_result`: `TRUNK`, `VALID`, `BAD_PARENT_NAME`, `BAD_PARENT_REVISION`, or `NULL`.
- `last_submitted_version`: commit recorded after a successful push and PR create/update.
- `last_submitted_base_branch`: PR base recorded by the same successful submission. Together with `last_submitted_version`, it prevents a topology-only move from being mistaken for an unchanged stack.
- `state`: nullable branch state reserved for future `gg` use.

`parent_branch_name` is the single source of truth for topology. Direct-child indexes are derived in memory from those parent pointers; no reciprocal child list is stored. The normalization migration preserves the ordering from the former `children` arrays in `sibling_order` before dropping that redundant column.

A branch needs restacking when its parent's current head differs from `parent_branch_revision`. Only the direct child of a rewritten parent becomes stale immediately; grandchildren become stale as their own parents are replayed.

## Recovery JSON lifecycle

While restack-derived mutation is active, `.gg_continue` has the fields below (undefined fields are omitted):

```json
{
  "currentBranchOverride": "feature-b",
  "branchesToRestack": ["feature-c"],
  "rebasedBranchBase": "<new parent oid>",
  "eventId": "<uuid>"
}
```

On successful completion or abort it becomes `{"branchesToRestack":[]}`. It is a lightweight hint, not the authoritative rollback record.

`.gg_operation_state` is the authoritative version-1 journal. It contains `command`, `eventId`, `ownerGitDir`, `currentBranchOverride`, the original and expected ref maps, original/expected/planned metadata snapshots, the original and remaining queues, optional pending parent changes, and the active branch's old head/base/new base. Inserted branch creation additionally records the pre-staging index and worktree trees plus the created ref's accepted checkpoints. It is created with exclusive filesystem semantics before mutation, updated atomically at each phase, and removed only after completion or a verified rollback. Its snapshots contain the same camel-case `BranchMetadata` fields documented above.

`.gg_mutation_lock` is acquired with exclusive-create semantics before every command that can change refs, metadata, configuration, remotes, or GitHub state. It is shared by linked worktrees through the common Git directory and records a random owner token, process ID, command, worktree Git directory, and start time. Read-only log commands bypass it after initialization. When the recorded process is definitively gone, the next mutating command serializes recovery through a short-lived `.gg_mutation_lock.recovery` guard, removes the unchanged stale lease, and retries acquisition once. The guard is removed in a `finally` path; if its process is terminated before cleanup, the next recovery reclaims both stale files. A live, malformed, unreadable, replaced, or otherwise unverifiable lock is never removed automatically.

## Legacy import

When the SQLite database is first created, `gg` scans `refs/branch-metadata/*` and imports valid JSON blobs shaped like:

```json
{
  "parentBranchName": "main",
  "parentBranchRevision": "<full commit oid>"
}
```

Import is one-way; `gg` never writes those refs.
