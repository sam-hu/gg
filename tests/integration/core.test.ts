import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { expectSuccess, gg, git, head, initRepo, read, withTempRoot, write } from '../helpers.js';

describe('core stacked-branch workflow', () => {
  test('initializes explicit and inferred trunks with gg-native metadata', async () => {
    await withTempRoot('init', (root) => {
      const repo = initRepo(root);
      const result = gg(repo, ['init', '--trunk', 'main']);
      expectSuccess(result);
      expect(result.stdout).toContain('Trunk set to main');

      const gitDir = path.join(repo, '.git');
      expect(statSync(path.join(gitDir, '.gg_metadata.db')).mode & 0o777).toBe(0o644);
      expect(statSync(path.join(gitDir, '.gg_repo_config')).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(gitDir, '.gg_local_pr_info'))).toBe(true);
      const db = new DatabaseSync(path.join(gitDir, '.gg_metadata.db'));
      const migrations = db.prepare('SELECT name FROM kysely_migration ORDER BY rowid').all();
      expect(migrations).toEqual([
        { name: '20260211_initial_schema' },
        { name: '20260212_add_validation_columns' },
        { name: '20260220_add_parent_head_revision' },
        { name: '20260717_normalize_graph_topology' },
        { name: '20260717_record_submitted_base_branch' },
      ]);
      expect(
        (db.prepare('PRAGMA table_info("branch_metadata")').all() as Array<{ name: string }>).map(
          ({ name }) => name,
        ),
      ).not.toContain('children');
      expect(db.prepare('SELECT branch_name FROM branch_metadata').get()).toEqual({
        branch_name: 'main',
      });
      db.close();

      const other = initRepo(root, 'inferred');
      expectSuccess(gg(other, ['init']));
      expect(gg(other, ['log', 'short']).stdout).toContain('main');
    });
  });

  test('prefers origin/HEAD and resets to a clean trunk-only graph', async () => {
    await withTempRoot('init-origin-head', (root) => {
      const repo = initRepo(root);
      expectSuccess(git(repo, 'branch', 'develop'));
      expectSuccess(git(repo, 'update-ref', 'refs/remotes/origin/develop', 'develop'));
      expectSuccess(
        git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'),
      );
      expectSuccess(gg(repo, ['init']));
      expect(gg(repo, ['log', 'short']).stdout).toContain('develop');

      expectSuccess(git(repo, 'switch', '-q', 'develop'));
      expectSuccess(gg(repo, ['bc', 'child']));
      expectSuccess(gg(repo, ['init', '--reset']));
      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(db.prepare('SELECT branch_name FROM branch_metadata').all()).toEqual([
        { branch_name: 'develop' },
      ]);
      db.close();
    });
  });

  test('serializes mutating commands while allowing initialized read-only logs', async () => {
    await withTempRoot('mutation-lease', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      const lock = path.join(repo, '.git', '.gg_mutation_lock');
      writeFileSync(
        lock,
        JSON.stringify({
          token: 'held-by-test',
          pid: process.pid,
          command: 'submit',
          gitDir: path.join(repo, '.git'),
          startedAt: new Date().toISOString(),
        }),
      );

      const blocked = gg(repo, ['bc', 'blocked']);
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain('Another gg process');
      expect(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/blocked').status).toBe(1);
      expectSuccess(gg(repo, ['log', 'short']));

      unlinkSync(lock);
      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      db.prepare('DELETE FROM kysely_migration WHERE name = ?').run(
        '20260717_record_submitted_base_branch',
      );
      db.close();
      writeFileSync(
        lock,
        JSON.stringify({
          token: 'held-during-migration',
          pid: process.pid,
          command: 'sync',
          gitDir: path.join(repo, '.git'),
          startedAt: new Date().toISOString(),
        }),
      );
      const blockedMigration = gg(repo, ['log', 'short']);
      expect(blockedMigration.status).toBe(1);
      expect(blockedMigration.stderr).toContain('Another gg process');
      unlinkSync(lock);
      expectSuccess(gg(repo, ['log', 'short']));

      expectSuccess(gg(repo, ['bc', 'allowed']));
      expect(existsSync(lock)).toBe(false);
    });
  });

  test('executes pending schema migrations against an existing metadata database', async () => {
    await withTempRoot('migrate-metadata', (root) => {
      const repo = initRepo(root);
      const dbPath = path.join(repo, '.git', '.gg_metadata.db');
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE branch_metadata (
          branch_name text not null primary key,
          parent_branch_name text,
          parent_branch_revision text,
          last_submitted_version text,
          state text,
          children text
        );
        CREATE TABLE kysely_migration (
          name varchar(255) not null primary key,
          timestamp varchar(255) not null
        );
        INSERT INTO kysely_migration VALUES ('20260211_initial_schema', '2026-02-11');
        INSERT INTO branch_metadata VALUES ('main', null, null, null, null, '["later","feature"]');
        INSERT INTO branch_metadata VALUES ('feature', 'main', null, null, null, '[]');
        INSERT INTO branch_metadata VALUES ('later', 'main', null, null, null, '[]');
      `);
      legacy.close();

      expectSuccess(gg(repo, ['init', '--trunk', 'main']));

      const migrated = new DatabaseSync(dbPath);
      expect(
        (
          migrated.prepare('PRAGMA table_info("branch_metadata")').all() as Array<{ name: string }>
        ).map(({ name }) => name),
      ).toEqual([
        'branch_name',
        'parent_branch_name',
        'parent_branch_revision',
        'last_submitted_version',
        'last_submitted_base_branch',
        'state',
        'sibling_order',
        'branch_revision',
        'validation_result',
        'parent_head_revision',
      ]);
      expect(migrated.prepare('SELECT name FROM kysely_migration ORDER BY rowid').all()).toEqual([
        { name: '20260211_initial_schema' },
        { name: '20260212_add_validation_columns' },
        { name: '20260220_add_parent_head_revision' },
        { name: '20260717_normalize_graph_topology' },
        { name: '20260717_record_submitted_base_branch' },
      ]);
      expect(
        migrated
          .prepare('SELECT branch_name, parent_branch_name FROM branch_metadata ORDER BY rowid')
          .all(),
      ).toEqual([
        { branch_name: 'main', parent_branch_name: null },
        { branch_name: 'feature', parent_branch_name: 'main' },
        { branch_name: 'later', parent_branch_name: 'main' },
      ]);
      expect(
        migrated
          .prepare(
            `SELECT branch_name FROM branch_metadata
             WHERE parent_branch_name = 'main' ORDER BY sibling_order`,
          )
          .all(),
      ).toEqual([{ branch_name: 'later' }, { branch_name: 'feature' }]);
      migrated.close();
    });
  });

  test('works from a nested directory and builds multiple independent stacks', async () => {
    await withTempRoot('navigation', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'a']));
      expectSuccess(gg(repo, ['bc', 'b']));
      expectSuccess(gg(repo, ['bottom']));
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('a');
      expectSuccess(gg(repo, ['top']));
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('b');
      expectSuccess(gg(repo, ['down', '2']));
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('main');

      expectSuccess(gg(repo, ['bc', 'other']));
      const nested = path.join(repo, 'nested', 'directory');
      mkdirSync(nested, { recursive: true });
      const log = gg(nested, ['log', 'short']);
      expectSuccess(log);
      expect(log.stdout).toContain('a');
      expect(log.stdout).toContain('b');
      expect(log.stdout).toContain('other');
    });
  });

  test('validates branch names before staging changes', async () => {
    await withTempRoot('invalid-branch-name', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'unstaged.txt', 'leave me unstaged\n');

      const invalid = gg(repo, ['bc', 'bad name', '--all', '-m', 'Invalid']);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('Invalid branch name');
      expect(git(repo, 'diff', '--cached', '--quiet').status).toBe(0);
      expect(git(repo, 'status', '--short', 'unstaged.txt').stdout.trim()).toBe('?? unstaged.txt');
      expect(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/bad name').status).toBe(1);
    });
  });

  test('aborts a conflicting inserted branch creation back to its exact starting state', async () => {
    await withTempRoot('insert-abort', (root) => {
      const repo = initRepo(root);
      write(repo, 'shared.txt', 'base\n');
      expectSuccess(git(repo, 'add', 'shared.txt'));
      expectSuccess(git(repo, 'commit', '-q', '-m', 'shared base'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));

      expectSuccess(gg(repo, ['bc', 'first-child']));
      write(repo, 'first.txt', 'first\n');
      expectSuccess(gg(repo, ['cc', '--all', '-m', 'First child']));
      const firstHead = head(repo, 'first-child');
      expectSuccess(gg(repo, ['down']));

      expectSuccess(gg(repo, ['bc', 'second-child']));
      write(repo, 'shared.txt', 'second child\n');
      expectSuccess(gg(repo, ['cc', '--all', '-m', 'Second child']));
      const secondHead = head(repo, 'second-child');
      expectSuccess(gg(repo, ['down']));

      write(repo, 'shared.txt', 'inserted\n');
      const inserted = gg(repo, ['bc', 'inserted', '--insert', '--all', '-m', 'Inserted']);
      expect(inserted.status).toBe(1);
      expect(inserted.stderr).toContain('Hit conflict restacking second-child on inserted.');
      expect(existsSync(path.join(repo, '.git', '.gg_operation_state'))).toBe(true);

      const insertedHead = head(repo, 'inserted');
      const externalCommit = git(
        repo,
        'commit-tree',
        head(repo, 'inserted^{tree}'),
        '-p',
        insertedHead,
        '-m',
        'External inserted branch change',
      );
      expectSuccess(externalCommit);
      const externalHead = externalCommit.stdout.trim();
      expectSuccess(git(repo, 'update-ref', 'refs/heads/inserted', externalHead, insertedHead));
      const guardedAbort = gg(repo, ['abort', '--force']);
      expect(guardedAbort.status).toBe(1);
      expect(guardedAbort.stderr).toContain('newly created branch inserted changed outside');
      expectSuccess(git(repo, 'update-ref', 'refs/heads/inserted', insertedHead, externalHead));

      expectSuccess(gg(repo, ['abort', '--force']));
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('main');
      expect(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/inserted').status).toBe(1);
      expect(head(repo, 'first-child')).toBe(firstHead);
      expect(head(repo, 'second-child')).toBe(secondHead);
      expect(read(repo, 'shared.txt')).toBe('inserted\n');
      expect(git(repo, 'diff', '--cached', '--quiet').status).toBe(0);
      expect(git(repo, 'diff', '--quiet').status).toBe(1);
      expect(existsSync(path.join(repo, '.git', '.gg_operation_state'))).toBe(false);

      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db
          .prepare(
            `SELECT branch_name, parent_branch_name FROM branch_metadata
             WHERE branch_name IN ('first-child', 'second-child') ORDER BY branch_name`,
          )
          .all(),
      ).toEqual([
        { branch_name: 'first-child', parent_branch_name: 'main' },
        { branch_name: 'second-child', parent_branch_name: 'main' },
      ]);
      db.close();
    });
  });

  test('amends a lower branch and restacks every descendant', async () => {
    await withTempRoot('commit', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'a.txt', 'a1\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A']));
      write(repo, 'b.txt', 'b1\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B']));
      write(repo, 'c.txt', 'c1\n');
      expectSuccess(gg(repo, ['bc', 'c', '--all', '-m', 'C']));
      const oldB = head(repo, 'b');
      const oldC = head(repo, 'c');

      expectSuccess(gg(repo, ['bottom']));
      write(repo, 'a.txt', 'a2\n');
      const created = gg(repo, ['--debug', 'cc', '--all', '-m', 'A followup']);
      expectSuccess(created);
      expect(
        created.stderr.match(
          /git for-each-ref --format=%\(refname:short\)%00%\(objectname\) refs\/heads/g,
        ),
      ).toHaveLength(1);
      expect(created.stderr).not.toContain('git show -s --format=%an%x00%ae%x00%aI%x00%B');
      expect(head(repo, 'b')).not.toBe(oldB);
      expect(head(repo, 'c')).not.toBe(oldC);
      const afterCreateB = head(repo, 'b');
      const afterCreateC = head(repo, 'c');
      write(repo, 'a.txt', 'a3\n');
      const amend = gg(repo, ['ca', '--all', '-m', 'A amended']);
      expectSuccess(amend);
      expect(head(repo, 'b')).not.toBe(afterCreateB);
      expect(head(repo, 'c')).not.toBe(afterCreateC);
      expect(git(repo, 'merge-base', '--is-ancestor', 'a', 'b').status).toBe(0);
      expect(git(repo, 'merge-base', '--is-ancestor', 'b', 'c').status).toBe(0);

      expectSuccess(git(repo, 'commit', '-q', '--allow-empty', '-m', 'direct parent advance'));
      expectSuccess(gg(repo, ['top']));
      const explicit = gg(repo, ['restack']);
      expectSuccess(explicit);
      expect(explicit.stdout).toContain(
        'Restacked 3 branches\n  ├─ a → main\n  ├─ b → a\n  └─ c → b\n\n✔ Stack ready.\n',
      );
    });
  });

  test('halts on conflict, continues, and can abort a later conflict without metadata loss', async () => {
    await withTempRoot('conflict', (root) => {
      const repo = initRepo(root);
      write(repo, 'shared.txt', 'base\n');
      expectSuccess(git(repo, 'add', 'shared.txt'));
      expectSuccess(git(repo, 'commit', '-q', '-m', 'shared base'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(git(repo, 'branch', 'side', 'main'));

      write(repo, 'shared.txt', 'parent\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'parent']));
      write(repo, 'shared.txt', 'child\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'child']));
      expectSuccess(gg(repo, ['down']));
      write(repo, 'shared.txt', 'parent changed\n');
      expectSuccess(gg(repo, ['ca', '--all', '-m', 'parent changed']));
      expectSuccess(gg(repo, ['up']));

      const conflict = gg(repo, ['restack']);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Hit conflict restacking b on a.');
      expect(existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(true);
      write(repo, 'shared.txt', 'resolved\n');
      const continued = gg(repo, ['continue', '--all']);
      expectSuccess(continued);
      expect(read(repo, 'shared.txt')).toBe('resolved\n');
      expect(existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(false);

      expectSuccess(gg(repo, ['down']));
      write(repo, 'shared.txt', 'parent final\n');
      expectSuccess(gg(repo, ['ca', '--all', '-m', 'parent final']));
      expectSuccess(gg(repo, ['up']));
      const branchBefore = head(repo, 'b');
      const dbBefore = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      const metadataBefore = dbBefore
        .prepare('SELECT * FROM branch_metadata ORDER BY branch_name')
        .all();
      dbBefore.close();
      expect(gg(repo, ['restack']).status).toBe(1);
      const sideBefore = head(repo, 'side');
      expectSuccess(git(repo, 'update-ref', '-d', 'refs/heads/side', sideBefore));
      const deletedAbort = gg(repo, ['abort', '--force']);
      expect(deletedAbort.status).toBe(1);
      expect(deletedAbort.stderr).toContain('was deleted outside');
      expectSuccess(git(repo, 'update-ref', 'refs/heads/side', sideBefore));
      const sideTree = head(repo, 'side^{tree}');
      const sideCommit = git(
        repo,
        'commit-tree',
        sideTree,
        '-p',
        sideBefore,
        '-m',
        'external side',
      );
      expectSuccess(sideCommit);
      const externalSide = sideCommit.stdout.trim();
      expectSuccess(git(repo, 'update-ref', 'refs/heads/side', externalSide, sideBefore));
      const guardedAbort = gg(repo, ['abort', '--force']);
      expect(guardedAbort.status).toBe(1);
      expect(guardedAbort.stderr).toContain('changed outside');
      expect(head(repo, 'side')).toBe(externalSide);
      expectSuccess(git(repo, 'update-ref', 'refs/heads/side', sideBefore, externalSide));
      expectSuccess(gg(repo, ['abort', '--force']));
      expect(head(repo, 'b')).toBe(branchBefore);
      const dbAfter = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(dbAfter.prepare('SELECT * FROM branch_metadata ORDER BY branch_name').all()).toEqual(
        metadataBefore,
      );
      dbAfter.close();
    });
  });

  test('moves stacks, implements children-first --only, and rejects cycles', async () => {
    await withTempRoot('move', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'parent']));
      expectSuccess(gg(repo, ['bc', 'source']));
      expectSuccess(gg(repo, ['bc', 'child']));
      const cycle = gg(repo, ['move', '--source', 'parent', '--onto', 'child']);
      expect(cycle.status).toBe(1);
      expect(cycle.stderr).toContain("because it's a child of it");

      expectSuccess(gg(repo, ['down', '3']));
      expectSuccess(gg(repo, ['bc', 'other']));
      const moved = gg(repo, ['move', '--source', 'source', '--onto', 'other', '--only']);
      expectSuccess(moved);
      expect(moved.stdout.indexOf('Restacked child on parent.')).toBeLessThan(
        moved.stdout.indexOf('Restacked source on other.'),
      );
      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db
          .prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?')
          .get('child'),
      ).toEqual({ parent_branch_name: 'parent' });
      expect(
        db
          .prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?')
          .get('source'),
      ).toEqual({ parent_branch_name: 'other' });
      db.close();
    });
  });

  test('silently omits missing tracked branches and protects staged checked-out restacks', async () => {
    await withTempRoot('safety', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'a']));
      expectSuccess(gg(repo, ['bc', 'b']));
      expectSuccess(gg(repo, ['down']));
      expectSuccess(git(repo, 'commit', '-q', '--allow-empty', '-m', 'advance a'));
      expectSuccess(gg(repo, ['up']));
      write(repo, 'staged.txt', 'keep me\n');
      expectSuccess(git(repo, 'add', 'staged.txt'));
      const blocked = gg(repo, ['restack', '--only']);
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain('changes staged');
      expect(git(repo, 'diff', '--cached', '--name-only').stdout).toContain('staged.txt');
      expectSuccess(git(repo, 'reset', '-q'));
      expectSuccess(git(repo, 'branch', '-D', 'a'));
      const log = gg(repo, ['log', 'short']);
      expectSuccess(log);
      expect(log.stdout).not.toContain('no longer exist locally');
      expect(log.stdout).not.toContain('◯  a');
    });
  });

  test('ignores a deleted sibling during upward navigation and rejects a deleted parent', async () => {
    await withTempRoot('stale-navigation', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'alive']));
      expectSuccess(gg(repo, ['down']));
      expectSuccess(gg(repo, ['bc', 'deleted-sibling']));
      expectSuccess(gg(repo, ['down']));
      expectSuccess(git(repo, 'branch', '-D', 'deleted-sibling'));
      expectSuccess(gg(repo, ['up']));
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('alive');

      expectSuccess(gg(repo, ['bc', 'child']));
      expectSuccess(git(repo, 'branch', '-D', 'alive'));
      const down = gg(repo, ['down']);
      expect(down.status).toBe(1);
      expect(down.stderr).toContain('Tracked parent branch alive');
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('child');
    });
  });

  test('renders classic and long logs, supports alias flags, and refuses zero-commit amend', async () => {
    await withTempRoot('log-forms', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'empty']));
      const amend = gg(repo, ['ca', '--all', '-m', 'must not amend trunk']);
      expect(amend.status).toBe(1);
      expect(amend.stderr).toContain('No changes to commit');
      expectSuccess(git(repo, 'branch', 'untracked', 'main'));

      const classic = gg(repo, ['ls', '--classic', '--reverse']);
      expectSuccess(classic);
      expect(classic.stdout).toContain('↱ $ empty');
      const long = gg(repo, ['ll', '--show-untracked']);
      expectSuccess(long);
      expect(long.stdout).toContain('untracked');
    });
  });

  test('renders sibling branches as parallel colored lanes', async () => {
    await withTempRoot('log-siblings', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'sibling-one']));
      expectSuccess(git(repo, 'switch', '-q', 'main'));
      expectSuccess(gg(repo, ['bc', 'sibling-two']));

      const log = gg(repo, ['l']);
      expectSuccess(log);
      const lines = log.stdout.split('\n');
      const first = lines.indexOf('◯ sibling-one');
      const second = lines.indexOf('│  ◉ sibling-two (current)');
      const join = lines.indexOf('├──┘');
      const trunk = lines.indexOf('◯ main');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      expect(join).toBeGreaterThan(second);
      expect(trunk).toBeGreaterThan(join);
      expect(log.stdout.match(/ - initial/g)).toHaveLength(1);

      const colored = gg(repo, ['l'], { FORCE_COLOR: '1' });
      expectSuccess(colored);
      expect(colored.stdout).toContain('\u001b[36m');
      expect(colored.stdout).toContain('\u001b[94m');
      expect(colored.stdout).toContain('\u001b[37m');
      expect(colored.stdout).toContain('\u001b[90m');
    });
  });

  test('renders every commit belonging to the top branch', async () => {
    await withTempRoot('log-multi-commit', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'feature.txt', 'first\n');
      expectSuccess(gg(repo, ['bc', 'feature', '--all', '-m', 'first feature commit']));
      write(repo, 'feature.txt', 'second\n');
      expectSuccess(gg(repo, ['cc', '--all', '-m', 'second feature commit']));

      const metadata = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      const dataVersionBefore = metadata.prepare('PRAGMA data_version').get();
      const log = gg(repo, ['l']);
      expectSuccess(log);
      const second = log.stdout.indexOf(' - second feature commit');
      const first = log.stdout.indexOf(' - first feature commit');
      const trunk = log.stdout.indexOf('◯ main');
      expect(second).toBeGreaterThanOrEqual(0);
      expect(first).toBeGreaterThan(second);
      expect(trunk).toBeGreaterThan(first);
      expect(log.stdout.match(/ - first feature commit/g)).toHaveLength(1);
      expect(log.stdout.match(/ - second feature commit/g)).toHaveLength(1);

      const repeated = gg(repo, ['--debug', 'l']);
      expectSuccess(repeated);
      const stableOutput = (output: string): string =>
        output
          .split('\n')
          .filter((line) => !/\b(?:ago|from now)$/.test(line))
          .join('\n');
      expect(stableOutput(repeated.stdout)).toBe(stableOutput(log.stdout));
      expect(repeated.stderr).not.toContain('git show-ref');
      expect(repeated.stderr).not.toContain('git merge-base --is-ancestor');
      expect(repeated.stderr.match(/git for-each-ref/g)).toHaveLength(1);
      expect(metadata.prepare('PRAGMA data_version').get()).toEqual(dataVersionBefore);
      metadata.close();
    });
  });

  test('shares metadata across linked worktrees and blocks overlapping mutations', async () => {
    await withTempRoot('linked-worktree', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(git(repo, 'branch', 'linked-branch', 'main'));
      const linked = path.join(root, 'linked');
      expectSuccess(git(repo, 'worktree', 'add', '-q', linked, 'linked-branch'));
      const linkedLog = gg(linked, ['log', 'short']);
      expectSuccess(linkedLog);
      const linkedGitDir = git(linked, 'rev-parse', '--absolute-git-dir').stdout.trim();
      expect(existsSync(path.join(linkedGitDir, '.gg_local_pr_info'))).toBe(true);

      expectSuccess(git(repo, 'switch', '-q', '-c', 'conflict-parent'));
      write(repo, 'shared-linked.txt', 'parent\n');
      expectSuccess(git(repo, 'add', 'shared-linked.txt'));
      expectSuccess(git(repo, 'commit', '-q', '-m', 'parent side'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main', '--reset']));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(git(repo, 'switch', '-q', 'main'));
      write(repo, 'shared-linked.txt', 'base\n');
      expectSuccess(git(repo, 'add', 'shared-linked.txt'));
      expectSuccess(git(repo, 'commit', '-q', '-m', 'shared base'));
      expectSuccess(gg(repo, ['bc', 'a']));
      write(repo, 'shared-linked.txt', 'a\n');
      expectSuccess(gg(repo, ['cc', '--all', '-m', 'a change']));
      expectSuccess(gg(repo, ['bc', 'b']));
      write(repo, 'shared-linked.txt', 'b\n');
      expectSuccess(gg(repo, ['cc', '--all', '-m', 'b change']));
      expectSuccess(gg(repo, ['down']));
      write(repo, 'shared-linked.txt', 'a rewritten\n');
      expectSuccess(gg(repo, ['ca', '--all', '-m', 'a rewritten']));
      expectSuccess(gg(repo, ['up']));
      expect(gg(repo, ['restack']).status).toBe(1);

      expectSuccess(gg(linked, ['log', 'short']));
      const blocked = gg(linked, ['bc', 'should-not-exist']);
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain('operation was interrupted');
      expect(
        git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/should-not-exist').status,
      ).toBe(1);
      expectSuccess(gg(repo, ['abort', '--force']));
    });
  });

  test('temporary helper cleans up after success and failure', async () => {
    let success = '';
    await withTempRoot('cleanup-success', (root) => {
      success = root;
      expect(existsSync(root)).toBe(true);
    });
    expect(existsSync(success)).toBe(false);
    const failureParent = await (async () => {
      let captured = '';
      try {
        await withTempRoot('cleanup-failure', (root) => {
          captured = root;
          throw new Error('injected failure');
        });
      } catch {
        return captured;
      }
      return captured;
    })();
    expect(existsSync(failureParent)).toBe(false);
  });

  test('installation harness removes its marked root when interrupted', async () => {
    await withTempRoot('interrupt', async (root) => {
      const child = spawn(process.execPath, [path.resolve('scripts/smoke-install.mjs')], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          GG_INSTALL_TMPDIR: root,
          GG_INSTALL_SMOKE_PAUSE_MS: '60000',
        },
        stdio: 'ignore',
      });
      const exitPromise = once(child, 'exit');
      let exited = false;
      const deadline = Date.now() + 5_000;
      try {
        while (readdirSync(root).length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(readdirSync(root)).toHaveLength(1);
        child.kill('SIGTERM');
        await exitPromise;
        exited = true;
        expect(readdirSync(root)).toHaveLength(0);
      } finally {
        if (!exited) {
          child.kill('SIGTERM');
          await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        }
      }
    });
  });
});
