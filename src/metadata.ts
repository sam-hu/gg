import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Git } from './git.js';

export type ValidationResult = 'TRUNK' | 'VALID' | 'BAD_PARENT_NAME' | 'BAD_PARENT_REVISION' | null;

export interface BranchMetadata {
  branchName: string;
  parentBranchName: string | null;
  parentBranchRevision: string | null;
  lastSubmittedVersion: string | null;
  state: string | null;
  children: string[];
  branchRevision: string | null;
  validationResult: ValidationResult;
  parentHeadRevision: string | null;
}

interface DatabaseRow {
  branch_name: string;
  parent_branch_name: string | null;
  parent_branch_revision: string | null;
  last_submitted_version: string | null;
  state: string | null;
  children: string | null;
  branch_revision: string | null;
  validation_result: ValidationResult;
  parent_head_revision: string | null;
}

export interface RepoConfig {
  trunk: string;
  trunks: Array<{ name: string }>;
  lastFetchedPRInfoMs?: number;
  lastFetchedFeatureFlagsInMs?: number;
}

export interface MetadataSnapshot {
  rows: BranchMetadata[];
}

export class MetadataStore {
  readonly git: Git;
  readonly dbPath: string;
  readonly configPath: string;
  readonly prInfoPath: string;
  readonly localPrInfoPath: string;
  readonly continuePath: string;
  readonly operationPath: string;
  private readonly db: DatabaseSync;

  private constructor(git: Git, db: DatabaseSync) {
    this.git = git;
    this.db = db;
    this.dbPath = path.join(git.commonGitDir, '.gg_metadata.db');
    this.configPath = path.join(git.commonGitDir, '.gg_repo_config');
    this.prInfoPath = path.join(git.commonGitDir, '.gg_pr_info');
    this.localPrInfoPath = path.join(git.gitDir, '.gg_local_pr_info');
    this.continuePath = path.join(git.gitDir, '.gg_continue');
    // The continuation hint is worktree-local, but gg's richer recovery journal
    // is shared so two linked worktrees cannot mutate the same refs and SQLite
    // graph concurrently.
    this.operationPath = path.join(git.commonGitDir, '.gg_operation_state');
  }

  static open(git: Git): MetadataStore {
    const dbPath = path.join(git.commonGitDir, '.gg_metadata.db');
    const existed = existsSync(dbPath);
    const db = new DatabaseSync(dbPath);
    const store = new MetadataStore(git, db);
    store.ensureSchema();
    chmodSync(dbPath, 0o644);
    if (!existed) store.importLegacyMetadata();
    if (MetadataStore.isInitialized(git)) store.ensurePrInfo();
    return store;
  }

  static isInitialized(git: Git): boolean {
    return existsSync(path.join(git.commonGitDir, '.gg_repo_config'));
  }

  close(): void {
    this.db.close();
  }

  config(): RepoConfig | undefined {
    if (!existsSync(this.configPath)) return undefined;
    try {
      return JSON.parse(this.gitFile(this.configPath)) as RepoConfig;
    } catch {
      return undefined;
    }
  }

  trunk(): string {
    const config = this.config();
    if (!config?.trunk) throw new Error('gg repository configuration is missing a trunk.');
    return config.trunk;
  }

  writeConfig(config: RepoConfig): void {
    atomicWrite(this.configPath, JSON.stringify(config, null, 2), 0o600);
  }

  ensurePrInfo(): void {
    if (!existsSync(this.prInfoPath)) {
      atomicWrite(
        this.prInfoPath,
        JSON.stringify({ prInfos: [], mergeabilityStatuses: [] }, null, 2),
        0o600,
      );
    }
    if (!existsSync(this.localPrInfoPath)) {
      atomicWrite(this.localPrInfoPath, JSON.stringify({ localPrInfo: [] }, null, 2), 0o600);
    }
  }

  initialize(trunk: string, trunkRevision: string, reset = false): void {
    const currentConfig = this.config();
    this.transaction(() => {
      if (reset || (currentConfig && currentConfig.trunk !== trunk)) {
        this.db.exec('DELETE FROM branch_metadata');
      }
      const existing = this.get(trunk);
      this.put({
        branchName: trunk,
        parentBranchName: null,
        parentBranchRevision: null,
        lastSubmittedVersion: existing?.lastSubmittedVersion ?? null,
        state: existing?.state ?? null,
        children: reset ? [] : (existing?.children ?? []),
        branchRevision: trunkRevision,
        validationResult: existing?.validationResult ?? null,
        parentHeadRevision: null,
      });
    });
    this.writeConfig({ trunk, trunks: [{ name: trunk }] });
    this.ensurePrInfo();
  }

  all(): BranchMetadata[] {
    return (
      this.db
        .prepare('SELECT * FROM branch_metadata ORDER BY branch_name')
        .all() as unknown as DatabaseRow[]
    ).map(fromRow);
  }

  get(branch: string): BranchMetadata | undefined {
    const row = this.db
      .prepare('SELECT * FROM branch_metadata WHERE branch_name = ?')
      .get(branch) as unknown as DatabaseRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  put(row: BranchMetadata): void {
    this.db
      .prepare(
        `INSERT INTO branch_metadata (
          branch_name, parent_branch_name, parent_branch_revision,
          last_submitted_version, state, children, branch_revision,
          validation_result, parent_head_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(branch_name) DO UPDATE SET
          parent_branch_name = excluded.parent_branch_name,
          parent_branch_revision = excluded.parent_branch_revision,
          last_submitted_version = excluded.last_submitted_version,
          state = excluded.state,
          children = excluded.children,
          branch_revision = excluded.branch_revision,
          validation_result = excluded.validation_result,
          parent_head_revision = excluded.parent_head_revision`,
      )
      .run(
        row.branchName,
        row.parentBranchName,
        row.parentBranchRevision,
        row.lastSubmittedVersion,
        row.state,
        JSON.stringify(row.children),
        row.branchRevision,
        row.validationResult,
        row.parentHeadRevision,
      );
  }

  delete(branch: string): void {
    const row = this.get(branch);
    if (!row) return;
    this.transaction(() => {
      if (row.parentBranchName) {
        const parent = this.get(row.parentBranchName);
        if (parent) {
          parent.children = parent.children.filter((child) => child !== branch);
          this.put(parent);
        }
      }
      this.db.prepare('DELETE FROM branch_metadata WHERE branch_name = ?').run(branch);
    });
  }

  deleteAndReparent(branch: string, parent: string, children: string[]): void {
    const row = this.get(branch);
    if (!row) return;
    this.transaction(() => {
      const parentRow = this.get(parent);
      if (!parentRow) throw new Error(`Missing metadata for parent ${parent}`);
      parentRow.children = parentRow.children.filter((name) => name !== branch);
      for (const child of children) {
        const childRow = this.get(child);
        if (!childRow) continue;
        childRow.parentBranchName = parent;
        if (!parentRow.children.includes(child)) parentRow.children.push(child);
        this.put(childRow);
      }
      this.put(parentRow);
      this.db.prepare('DELETE FROM branch_metadata WHERE branch_name = ?').run(branch);
    });
  }

  track(branch: string, parent: string, parentRevision: string, branchRevision: string): void {
    this.transaction(() => {
      const previous = this.get(branch);
      if (previous?.parentBranchName && previous.parentBranchName !== parent) {
        const oldParent = this.get(previous.parentBranchName);
        if (oldParent) {
          oldParent.children = oldParent.children.filter((name) => name !== branch);
          this.put(oldParent);
        }
      }
      const parentRow = this.get(parent);
      if (parentRow && !parentRow.children.includes(branch)) {
        parentRow.children.push(branch);
        this.put(parentRow);
      }
      this.put({
        branchName: branch,
        parentBranchName: parent,
        parentBranchRevision: parentRevision,
        lastSubmittedVersion: previous?.lastSubmittedVersion ?? null,
        state: previous?.state ?? null,
        children: previous?.children ?? [],
        branchRevision,
        validationResult: null,
        parentHeadRevision: parentRevision,
      });
    });
  }

  setParent(branch: string, parent: string, baseRevision: string): void {
    const row = this.get(branch);
    if (!row) throw new Error(`Missing metadata for ${branch}`);
    this.transaction(() => {
      if (row.parentBranchName) {
        const previous = this.get(row.parentBranchName);
        if (previous) {
          previous.children = previous.children.filter((child) => child !== branch);
          this.put(previous);
        }
      }
      const next = this.get(parent);
      if (next && !next.children.includes(branch)) {
        next.children.push(branch);
        this.put(next);
      }
      row.parentBranchName = parent;
      row.parentBranchRevision = baseRevision;
      row.parentHeadRevision = baseRevision;
      this.put(row);
    });
  }

  updateAfterRestack(
    branch: string,
    parentRevision: string,
    branchRevision: string,
    newParent?: string,
  ): void {
    this.transaction(() => {
      const row = this.get(branch);
      if (!row) throw new Error(`Missing metadata for ${branch}`);
      if (newParent && row.parentBranchName !== newParent) {
        if (row.parentBranchName) {
          const previous = this.get(row.parentBranchName);
          if (previous) {
            previous.children = previous.children.filter((child) => child !== branch);
            this.put(previous);
          }
        }
        const next = this.get(newParent);
        if (!next) throw new Error(`Missing metadata for parent ${newParent}`);
        if (!next.children.includes(branch)) next.children.push(branch);
        this.put(next);
        row.parentBranchName = newParent;
      }
      row.parentBranchRevision = parentRevision;
      row.parentHeadRevision = parentRevision;
      row.branchRevision = branchRevision;
      row.validationResult = 'VALID';
      this.put(row);
    });
  }

  previewAfterRestack(
    branch: string,
    parentRevision: string,
    branchRevision: string,
    newParent?: string,
  ): MetadataSnapshot {
    const snapshot = structuredClone(this.snapshot());
    const rows = new Map(snapshot.rows.map((row) => [row.branchName, row]));
    const row = rows.get(branch);
    if (!row) throw new Error(`Missing metadata for ${branch}`);
    if (newParent && row.parentBranchName !== newParent) {
      if (row.parentBranchName) {
        const previous = rows.get(row.parentBranchName);
        if (previous) previous.children = previous.children.filter((child) => child !== branch);
      }
      const next = rows.get(newParent);
      if (!next) throw new Error(`Missing metadata for parent ${newParent}`);
      if (!next.children.includes(branch)) next.children.push(branch);
      row.parentBranchName = newParent;
    }
    row.parentBranchRevision = parentRevision;
    row.parentHeadRevision = parentRevision;
    row.branchRevision = branchRevision;
    row.validationResult = 'VALID';
    return snapshot;
  }

  updateBranchRevision(branch: string, revision: string): void {
    const row = this.get(branch);
    if (!row) return;
    row.branchRevision = revision;
    this.put(row);
  }

  snapshot(): MetadataSnapshot {
    return { rows: this.all() };
  }

  restore(snapshot: MetadataSnapshot): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM branch_metadata');
      for (const row of snapshot.rows) this.put(row);
    });
  }

  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "branch_metadata" (
        "branch_name" text not null primary key,
        "parent_branch_name" text,
        "parent_branch_revision" text,
        "last_submitted_version" text,
        "state" text,
        "children" text,
        "branch_revision" text,
        "validation_result" text,
        "parent_head_revision" text
      );
      CREATE INDEX IF NOT EXISTS "idx_branch_metadata_parent"
        on "branch_metadata" ("parent_branch_name");
      CREATE TABLE IF NOT EXISTS "kysely_migration" (
        "name" varchar(255) not null primary key,
        "timestamp" varchar(255) not null
      );
      CREATE TABLE IF NOT EXISTS "kysely_migration_lock" (
        "id" varchar(255) not null primary key,
        "is_locked" integer default 0 not null
      );
    `);
    const insertMigration = this.db.prepare(
      'INSERT OR IGNORE INTO kysely_migration (name, timestamp) VALUES (?, ?)',
    );
    for (const name of [
      '20260211_initial_schema',
      '20260212_add_validation_columns',
      '20260220_add_parent_head_revision',
    ]) {
      insertMigration.run(name, new Date().toISOString());
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO kysely_migration_lock (id, is_locked)
         VALUES ('migration_lock', 0)`,
      )
      .run();
  }

  private importLegacyMetadata(): void {
    const refs = this.git.run(['for-each-ref', '--format=%(refname)', 'refs/branch-metadata'], {
      allowFailure: true,
    });
    if (refs.status !== 0 || !refs.stdout.trim()) return;
    const imported: Array<{
      branch: string;
      parent: string;
      parentRevision: string;
    }> = [];
    for (const ref of refs.stdout.trim().split('\n')) {
      try {
        const value = JSON.parse(this.git.capture(['cat-file', '-p', ref])) as {
          parentBranchName?: string;
          parentBranchRevision?: string;
        };
        const branch = ref.slice('refs/branch-metadata/'.length);
        if (
          branch &&
          value.parentBranchName &&
          value.parentBranchRevision &&
          this.git.branchExists(branch) &&
          this.git.branchExists(value.parentBranchName)
        ) {
          imported.push({
            branch,
            parent: value.parentBranchName,
            parentRevision: value.parentBranchRevision,
          });
        }
      } catch {
        // Malformed legacy refs are ignored during the best-effort one-way import.
      }
    }
    for (const item of imported) {
      if (!this.get(item.parent)) {
        this.put({
          branchName: item.parent,
          parentBranchName: null,
          parentBranchRevision: null,
          lastSubmittedVersion: null,
          state: null,
          children: [],
          branchRevision: this.git.tryHead(item.parent) ?? null,
          validationResult: null,
          parentHeadRevision: null,
        });
      }
      this.track(item.branch, item.parent, item.parentRevision, this.git.head(item.branch));
    }
  }

  private gitFile(file: string): string {
    return readFileSync(file, 'utf8');
  }
}

function fromRow(row: DatabaseRow): BranchMetadata {
  let children: string[] = [];
  try {
    const parsed = JSON.parse(row.children ?? '[]') as unknown;
    if (Array.isArray(parsed))
      children = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    children = [];
  }
  return {
    branchName: row.branch_name,
    parentBranchName: row.parent_branch_name,
    parentBranchRevision: row.parent_branch_revision,
    lastSubmittedVersion: row.last_submitted_version,
    state: row.state,
    children,
    branchRevision: row.branch_revision,
    validationResult: row.validation_result,
    parentHeadRevision: row.parent_head_revision,
  };
}

export function atomicWrite(file: string, contents: string, mode: number): void {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
    chmodSync(file, mode);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
