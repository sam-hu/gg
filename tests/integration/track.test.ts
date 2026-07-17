import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { expectSuccess, gg, git, head, initRepo, withTempRoot, write } from '../helpers.js';

describe('track', () => {
  test('tracks an existing current branch from its merge base and allows restacking it', async () => {
    await withTempRoot('track-current', (root) => {
      const repo = initRepo(root);
      const originalMain = head(repo, 'main');
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));

      expectSuccess(git(repo, 'switch', '-q', '-c', 'existing'));
      write(repo, 'feature.txt', 'feature\n');
      expectSuccess(git(repo, 'add', 'feature.txt'));
      expectSuccess(git(repo, 'commit', '-q', '-m', 'existing feature'));
      const originalFeature = head(repo, 'existing');

      expectSuccess(git(repo, 'switch', '-q', 'main'));
      write(repo, 'main.txt', 'main advanced\n');
      expectSuccess(git(repo, 'add', 'main.txt'));
      expectSuccess(git(repo, 'commit', '-q', '-m', 'advance main'));
      expectSuccess(git(repo, 'switch', '-q', 'existing'));

      const tracked = gg(repo, ['track', '--parent', 'main']);
      expectSuccess(tracked);
      expect(tracked.stdout).toContain('Tracked existing with parent main.');

      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db
          .prepare(
            'SELECT parent_branch_name, parent_branch_revision, branch_revision FROM branch_metadata WHERE branch_name = ?',
          )
          .get('existing'),
      ).toEqual({
        parent_branch_name: 'main',
        parent_branch_revision: originalMain,
        branch_revision: originalFeature,
      });
      db.close();

      const restacked = gg(repo, ['restack', '--only']);
      expectSuccess(restacked);
      expect(restacked.stdout).toContain(
        'Restacked 1 branch\n  └─ existing → main\n\n✔ Stack ready.\n',
      );
      expect(git(repo, 'merge-base', '--is-ancestor', 'main', 'existing').status).toBe(0);
    });
  });

  test('tracks a named branch without checking it out and supports safe retracking', async () => {
    await withTempRoot('track-named', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'parent']));
      expectSuccess(git(repo, 'branch', 'existing', 'parent'));
      expectSuccess(git(repo, 'switch', '-q', 'main'));

      expectSuccess(gg(repo, ['track', 'existing', '--parent', 'parent']));
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('main');
      expectSuccess(gg(repo, ['track', 'existing', '--parent', 'main']));

      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db
          .prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?')
          .get('existing'),
      ).toEqual({ parent_branch_name: 'main' });
      expect(
        db.prepare('SELECT children FROM branch_metadata WHERE branch_name = ?').get('parent'),
      ).toEqual({ children: '[]' });
      db.close();
    });
  });

  test('rejects invalid branches, parents, and metadata cycles', async () => {
    await withTempRoot('track-errors', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(git(repo, 'branch', 'untracked-parent'));
      expectSuccess(gg(repo, ['bc', 'a']));
      expectSuccess(gg(repo, ['bc', 'b']));

      expect(gg(repo, ['track', 'missing', '--parent', 'main']).stderr).toContain(
        'Could not find branch missing.',
      );
      expect(gg(repo, ['track', 'main', '--parent', 'a']).stderr).toContain(
        'Cannot track the trunk branch',
      );
      expect(gg(repo, ['track', 'b', '--parent', 'untracked-parent']).stderr).toContain(
        'untracked branch untracked-parent',
      );
      expect(gg(repo, ['track', 'b', '--parent', 'b']).stderr).toContain(
        'A branch cannot be its own parent.',
      );
      expect(gg(repo, ['track', 'a', '--parent', 'b']).stderr).toContain(
        'because it is a child of a',
      );
      expect(gg(repo, ['track', 'b']).stderr).toContain(
        'Cannot perform interactive operation in non-interactive mode.',
      );

      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db.prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?').get('a'),
      ).toEqual({ parent_branch_name: 'main' });
      db.close();
    });
  });
});
