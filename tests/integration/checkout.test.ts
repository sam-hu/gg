import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, test } from 'vitest';
import { expectSuccess, gg, git, initRepo, withTempRoot } from '../helpers.js';

const cli = path.resolve('dist/cli.js');

describe('branch checkout', () => {
  test('checks out explicit tracked and untracked local branches', async () => {
    await withTempRoot('checkout-explicit', (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'tracked']));
      expectSuccess(git(repo, 'switch', '-q', 'main'));
      expectSuccess(git(repo, 'branch', 'untracked'));

      const tracked = gg(repo, ['co', 'tracked']);
      expectSuccess(tracked);
      expect(tracked.stdout).toContain('Checked out tracked.');
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('tracked');

      const untracked = gg(repo, ['co', 'untracked']);
      expectSuccess(untracked);
      expect(untracked.stdout).toContain('Checked out untracked.');
      expect(untracked.stdout).toContain('This branch is not tracked by gg.');
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('untracked');
    });
  });

  test('selects a tracked branch from the topology-aware interactive tree', async () => {
    await withTempRoot('checkout-interactive', async (root) => {
      const repo = initRepo(root);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'stack1-1']));
      expectSuccess(gg(repo, ['bc', 'stack1-2']));
      expectSuccess(git(repo, 'switch', '-q', 'main'));
      expectSuccess(gg(repo, ['bc', 'stack2-1']));
      expectSuccess(git(repo, 'switch', '-q', 'main'));

      const child = spawn(process.execPath, [cli, '--cwd', repo, '--interactive', 'co'], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          FORCE_COLOR: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      await waitFor(() => stdout.includes('Checkout a branch'));
      for (const character of 'stack2') {
        child.stdin.write(character);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      child.stdin.end('\r');
      const [code] = (await once(child, 'exit')) as [number | null];

      expect(code, stderr).toBe(0);
      expect(stdout).toContain('\u001b[4m');
      const plainOutput = stripVTControlCharacters(stdout);
      expect(plainOutput).toContain('│ ○');
      expect(plainOutput).toContain('Checked out stack2-1.');
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('stack2-1');
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for checkout prompt.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
