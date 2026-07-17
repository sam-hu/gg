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
  siblingOrder: number;
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
  sibling_order: number;
  branch_revision: string | null;
  validation_result: ValidationResult;
  parent_head_revision: string | null;
}

interface SchemaMigration {
  name: string;
  up: (db: DatabaseSync) => void;
}

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  // Historical steps stay executable so a fresh database and an upgraded one
  // reach the same schema through the same ordered path.
  {
    name: '20260211_initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "branch_metadata" (
          "branch_name" text not null primary key,
          "parent_branch_name" text,
          "parent_branch_revision" text,
          "last_submitted_version" text,
          "state" text,
          "children" text
        );
        CREATE INDEX IF NOT EXISTS "idx_branch_metadata_parent"
          on "branch_metadata" ("parent_branch_name");
      `);
    },
  },
  {
    name: '20260212_add_validation_columns',
    up(db) {
      addColumn(db, 'branch_revision', 'text');
      addColumn(db, 'validation_result', 'text');
    },
  },
  {
    name: '20260220_add_parent_head_revision',
    up(db) {
      addColumn(db, 'parent_head_revision', 'text');
    },
  },
  {
    name: '20260717_normalize_graph_topology',
    up(db) {
      normalizeGraphTopology(db);
    },
  },
];

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
        siblingOrder: 0,
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
          last_submitted_version, state, sibling_order, branch_revision,
          validation_result, parent_head_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(branch_name) DO UPDATE SET
          parent_branch_name = excluded.parent_branch_name,
          parent_branch_revision = excluded.parent_branch_revision,
          last_submitted_version = excluded.last_submitted_version,
          state = excluded.state,
          sibling_order = excluded.sibling_order,
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
        row.siblingOrder,
        row.branchRevision,
        row.validationResult,
        row.parentHeadRevision,
      );
  }

  childrenOf(parent: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT branch_name FROM branch_metadata
           WHERE parent_branch_name = ? ORDER BY sibling_order, rowid`,
        )
        .all(parent) as Array<{ branch_name: string }>
    ).map((row) => row.branch_name);
  }

  deleteAndReparent(branch: string, parent: string): string[] {
    const row = this.get(branch);
    if (!row) throw new Error(`Missing metadata for ${branch}`);
    return this.transaction(() => {
      if (!this.get(parent)) throw new Error(`Missing metadata for parent ${parent}`);
      const children = this.childrenOf(branch);
      let siblingOrder = this.nextSiblingOrder(parent);
      for (const child of children) {
        const childRow = this.get(child);
        if (!childRow) continue;
        childRow.parentBranchName = parent;
        childRow.siblingOrder = siblingOrder;
        siblingOrder += 1;
        this.put(childRow);
      }
      this.db.prepare('DELETE FROM branch_metadata WHERE branch_name = ?').run(branch);
      return children;
    });
  }

  track(branch: string, parent: string, parentRevision: string, branchRevision: string): void {
    this.transaction(() => {
      const previous = this.get(branch);
      this.put({
        branchName: branch,
        parentBranchName: parent,
        parentBranchRevision: parentRevision,
        lastSubmittedVersion: previous?.lastSubmittedVersion ?? null,
        state: previous?.state ?? null,
        siblingOrder:
          previous?.parentBranchName === parent
            ? previous.siblingOrder
            : this.nextSiblingOrder(parent),
        branchRevision,
        validationResult: null,
        parentHeadRevision: parentRevision,
      });
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
        if (!this.get(newParent)) throw new Error(`Missing metadata for parent ${newParent}`);
        row.parentBranchName = newParent;
        row.siblingOrder = this.nextSiblingOrder(newParent);
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
      if (!rows.has(newParent)) throw new Error(`Missing metadata for parent ${newParent}`);
      row.parentBranchName = newParent;
      row.siblingOrder =
        Math.max(
          -1,
          ...snapshot.rows
            .filter((candidate) => candidate.parentBranchName === newParent)
            .map((candidate) => candidate.siblingOrder),
        ) + 1;
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
      CREATE TABLE IF NOT EXISTS "kysely_migration" (
        "name" varchar(255) not null primary key,
        "timestamp" varchar(255) not null
      );
      CREATE TABLE IF NOT EXISTS "kysely_migration_lock" (
        "id" varchar(255) not null primary key,
        "is_locked" integer default 0 not null
      );
    `);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO kysely_migration_lock (id, is_locked)
         VALUES ('migration_lock', 0)`,
      )
      .run();
    const applied = new Set(
      (this.db.prepare('SELECT name FROM kysely_migration').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const recordMigration = this.db.prepare(
      'INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)',
    );
    for (const migration of SCHEMA_MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(this.db);
        recordMigration.run(migration.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
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
          siblingOrder: 0,
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

  private nextSiblingOrder(parent: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sibling_order) + 1, 0) AS next
         FROM branch_metadata WHERE parent_branch_name = ?`,
      )
      .get(parent) as { next: number };
    return row.next;
  }
}

function fromRow(row: DatabaseRow): BranchMetadata {
  return {
    branchName: row.branch_name,
    parentBranchName: row.parent_branch_name,
    parentBranchRevision: row.parent_branch_revision,
    lastSubmittedVersion: row.last_submitted_version,
    state: row.state,
    siblingOrder: row.sibling_order,
    branchRevision: row.branch_revision,
    validationResult: row.validation_result,
    parentHeadRevision: row.parent_head_revision,
  };
}

function hasColumn(db: DatabaseSync, column: string): boolean {
  return (db.prepare('PRAGMA table_info("branch_metadata")').all() as Array<{ name: string }>).some(
    (candidate) => candidate.name === column,
  );
}

function addColumn(db: DatabaseSync, column: string, type: string): void {
  if (!hasColumn(db, column))
    db.exec(`ALTER TABLE "branch_metadata" ADD COLUMN "${column}" ${type}`);
}

interface LegacyTopologyRow {
  source_order: number;
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

function normalizeGraphTopology(db: DatabaseSync): void {
  if (!hasColumn(db, 'children')) {
    addColumn(db, 'sibling_order', 'integer not null default 0');
    assignSiblingOrder(db);
    db.exec(
      'CREATE INDEX IF NOT EXISTS "idx_branch_metadata_parent" on "branch_metadata" ("parent_branch_name")',
    );
    return;
  }

  const rows = db
    .prepare('SELECT rowid AS source_order, * FROM branch_metadata ORDER BY rowid')
    .all() as unknown as LegacyTopologyRow[];
  const rowsByParent = new Map<string, LegacyTopologyRow[]>();
  for (const row of rows) {
    if (!row.parent_branch_name) continue;
    const siblings = rowsByParent.get(row.parent_branch_name) ?? [];
    siblings.push(row);
    rowsByParent.set(row.parent_branch_name, siblings);
  }
  const siblingOrders = new Map<string, number>();
  for (const [parent, siblings] of rowsByParent) {
    const siblingNames = new Set(siblings.map((row) => row.branch_name));
    const declared = parseLegacyChildren(rows.find((row) => row.branch_name === parent)?.children);
    const ordered = [
      ...declared.filter((branch) => siblingNames.has(branch)),
      ...siblings.map((row) => row.branch_name).filter((branch) => !declared.includes(branch)),
    ];
    ordered.forEach((branch, index) => siblingOrders.set(branch, index));
  }

  db.exec(`
    DROP INDEX IF EXISTS "idx_branch_metadata_parent";
    CREATE TABLE "branch_metadata_next" (
      "branch_name" text not null primary key,
      "parent_branch_name" text,
      "parent_branch_revision" text,
      "last_submitted_version" text,
      "state" text,
      "sibling_order" integer not null,
      "branch_revision" text,
      "validation_result" text,
      "parent_head_revision" text
    );
  `);
  const insert = db.prepare(`
    INSERT INTO "branch_metadata_next" (
      branch_name, parent_branch_name, parent_branch_revision,
      last_submitted_version, state, sibling_order, branch_revision,
      validation_result, parent_head_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.branch_name,
      row.parent_branch_name,
      row.parent_branch_revision,
      row.last_submitted_version,
      row.state,
      siblingOrders.get(row.branch_name) ?? 0,
      row.branch_revision,
      row.validation_result,
      row.parent_head_revision,
    );
  }
  db.exec(`
    DROP TABLE "branch_metadata";
    ALTER TABLE "branch_metadata_next" RENAME TO "branch_metadata";
    CREATE INDEX "idx_branch_metadata_parent"
      on "branch_metadata" ("parent_branch_name");
  `);
}

function assignSiblingOrder(db: DatabaseSync): void {
  const rows = db
    .prepare('SELECT rowid, parent_branch_name FROM branch_metadata ORDER BY rowid')
    .all() as Array<{ rowid: number; parent_branch_name: string | null }>;
  const nextOrder = new Map<string | null, number>();
  const update = db.prepare('UPDATE branch_metadata SET sibling_order = ? WHERE rowid = ?');
  for (const row of rows) {
    const order = nextOrder.get(row.parent_branch_name) ?? 0;
    update.run(order, row.rowid);
    nextOrder.set(row.parent_branch_name, order + 1);
  }
}

function parseLegacyChildren(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((child): child is string => typeof child === 'string')
      : [];
  } catch {
    return [];
  }
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
