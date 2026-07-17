import { describe, expect, test } from 'vitest';
import { gg, git, initRepo, withTempRoot, write } from '../helpers.js';

describe('Git command passthrough', () => {
  test('passes unrecognized commands and their arguments through to Git', async () => {
    await withTempRoot('git-passthrough', (root) => {
      const repo = initRepo(root);
      write(repo, 'staged.txt', 'staged through gg\n');

      const add = gg(repo, ['add', 'staged.txt']);
      expect(add.status).toBe(0);
      expect(git(repo, 'diff', '--cached', '--name-only').stdout.trim()).toBe('staged.txt');

      const status = gg(repo, ['status', '--short']);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain('A  staged.txt');
    });
  });

  test('preserves Git exit codes and supports gg global options', async () => {
    await withTempRoot('git-passthrough-errors', (root) => {
      const repo = initRepo(root);
      const missing = gg(repo, ['--debug', 'rev-parse', '--verify', 'missing-ref']);

      expect(missing.status).toBe(128);
      expect(missing.stderr).toContain('[debug] git rev-parse --verify missing-ref');
      expect(missing.stderr).toContain('fatal:');
      expect(missing.stderr).not.toContain('--cwd');
      expect(missing.stderr).not.toContain('--no-interactive');
    });
  });
});
