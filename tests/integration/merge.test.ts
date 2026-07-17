import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  createBareRemote,
  expectSuccess,
  gg,
  git,
  head,
  initRepo,
  installFakeGh,
  stateFrom,
  withTempRoot,
  write,
} from '../helpers.js';

describe('merge', () => {
  test('merges the bottom PR into trunk and restacks the remaining branches', async () => {
    await withTempRoot('merge-bottom', async (root) => {
      const { repo, bare, mergeSha, env } = createSubmittedStack(root);
      expectSuccess(gg(repo, ['bottom']));

      const result = await runInteractiveMerge(repo, { ...env, FORCE_COLOR: '1' }, '\r');
      expectSuccess(result);
      const plainOutput = stripVTControlCharacters(result.stdout);
      expect(normalizePromptOutput(result.stdout)).toContain(
        'a will be merged into main and this tree will be restacked. Confirm? (Y/n)',
      );
      expect(plainOutput).toContain('◉ a (current)');
      expect(plainOutput).toContain(
        [
          '✔ Merged PR #1  a → main',
          '',
          'Restacked 2 branches',
          '  ├─ b → main',
          '  └─ c → b',
          '',
          '🥞 Validating stack...',
          '',
          'Submitting 2 branches',
          '  ├─ ✔ PR #2  b → main  (updated)',
          '  │    https://github.com/owner/repo/pull/2',
          '  └─ ✔ PR #3  c → b  (updated)',
          '       https://github.com/owner/repo/pull/3',
          '',
          '✔ Stack submitted.',
        ].join('\n'),
      );
      expect(plainOutput).not.toContain('Branches to restack:');
      expect(plainOutput).not.toContain('Local stack updated');
      expect(result.stdout).toContain('\u001b[32m✔\u001b[39m');
      expect(result.stdout).toContain('\u001b[36ma\u001b[39m');
      expect(head(repo, 'main')).toBe(mergeSha);
      expect(head(bare, 'main')).toBe(mergeSha);
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('main');
      expect(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/a').status).toBe(1);
      expect(git(repo, 'rev-list', '--count', 'main..b').stdout.trim()).toBe('1');
      expect(git(repo, 'rev-list', '--count', 'b..c').stdout.trim()).toBe('1');

      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db.prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?').get('b'),
      ).toEqual({ parent_branch_name: 'main' });
      expect(
        db.prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?').get('c'),
      ).toEqual({ parent_branch_name: 'b' });
      expect(
        db.prepare('SELECT branch_name FROM branch_metadata WHERE branch_name = ?').get('a'),
      ).toBeUndefined();
      db.close();

      const state = stateFrom(env);
      expect(state.calls).toContainEqual({
        method: 'PUT',
        endpoint: 'repos/owner/repo/pulls/1/merge',
        body: { merge_method: 'squash', sha: state.expectedHead },
      });
      expect(state.prs[0].merged_at).toBeTruthy();
      expect(state.prs.find((pullRequest: any) => pullRequest.number === 2).base.ref).toBe('main');
      expect(state.prs.find((pullRequest: any) => pullRequest.number === 3).base.ref).toBe('b');
      expect(head(bare, 'b')).toBe(head(repo, 'b'));
      expect(head(bare, 'c')).toBe(head(repo, 'c'));
      expect(state.comments).toHaveLength(2);
    });
  });

  test('renders the current dependency subtree above a default-yes confirmation', async () => {
    await withTempRoot('merge-confirm', async (root) => {
      const { repo, env } = createSubmittedStack(root);
      expectSuccess(gg(repo, ['down']));
      write(repo, 'd.txt', 'd\n');
      expectSuccess(gg(repo, ['bc', 'd', '--all', '-m', 'D']));
      expectSuccess(gg(repo, ['co', 'b']));

      const cancelled = await runInteractiveMerge(repo, env, 'n\r');
      expectSuccess(cancelled);
      const cancelledOutput = normalizePromptOutput(cancelled.stdout);
      expect(cancelledOutput).toContain(
        'a will be merged into main and this tree will be restacked. Confirm? (Y/n)',
      );
      expect(cancelled.stdout).toContain('○   c\n│ ○ d\n◉─┘ b (current)\n○   a\n○   main\n');
      expect(cancelled.stdout).toContain('Merge cancelled.');
      expect(stateFrom(env).calls ?? []).toHaveLength(0);
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('b');

      const accepted = await runInteractiveMerge(repo, env, '\r');
      expectSuccess(accepted);
      const promptOutput = normalizePromptOutput(accepted.stdout);
      expect(promptOutput).toContain(
        'a will be merged into main and this tree will be restacked. Confirm? (Y/n)',
      );
      expect(accepted.stdout).toContain('✔ Merged PR #1  a → main');
      expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('b');
      expect(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/a').status).toBe(1);
      expect(stateFrom(env).calls.some((call: any) => call.method === 'PUT')).toBe(true);
    });
  });
});

function createSubmittedStack(root: string): {
  repo: string;
  bare: string;
  mergeSha: string;
  env: NodeJS.ProcessEnv;
} {
  const repo = initRepo(root);
  const bare = createBareRemote(root, repo);
  expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
  expectSuccess(gg(repo, ['init', '--trunk', 'main']));
  write(repo, 'a.txt', 'a\n');
  expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A']));
  write(repo, 'b.txt', 'b\n');
  expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B']));
  write(repo, 'c.txt', 'c\n');
  expectSuccess(gg(repo, ['bc', 'c', '--all', '-m', 'C']));
  expectSuccess(git(repo, 'push', '-q', 'origin', 'a', 'b', 'c'));

  const expectedHead = head(repo, 'a');
  const squash = git(
    repo,
    'commit-tree',
    head(repo, 'a^{tree}'),
    '-p',
    head(repo, 'main'),
    '-m',
    'A squash',
  );
  expectSuccess(squash);
  const mergeSha = squash.stdout.trim();
  expectSuccess(git(repo, 'push', '-q', 'origin', `${mergeSha}:refs/heads/merge-result`));

  const env = installFakeGh(root, {
    auth: true,
    expectedHead,
    mergeRemote: bare,
    mergeSha,
    prs: [
      {
        number: 1,
        node_id: 'PR_merge_1',
        html_url: 'https://github.com/owner/repo/pull/1',
        state: 'open',
        draft: false,
        title: 'A',
        body: '',
        head: { ref: 'a' },
        base: { ref: 'main' },
        requested_reviewers: [],
        requested_teams: [],
      },
      {
        number: 2,
        node_id: 'PR_merge_2',
        html_url: 'https://github.com/owner/repo/pull/2',
        state: 'open',
        draft: false,
        title: 'B',
        body: '',
        head: { ref: 'b' },
        base: { ref: 'a' },
        requested_reviewers: [],
        requested_teams: [],
      },
      {
        number: 3,
        node_id: 'PR_merge_3',
        html_url: 'https://github.com/owner/repo/pull/3',
        state: 'open',
        draft: false,
        title: 'C',
        body: '',
        head: { ref: 'c' },
        base: { ref: 'b' },
        requested_reviewers: [],
        requested_teams: [],
      },
    ],
  });
  return { repo, bare, mergeSha, env };
}

async function runInteractiveMerge(
  repo: string,
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [path.resolve('dist/cli.js'), '--cwd', repo, '--interactive', 'merge'],
    {
      cwd: repo,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        COLUMNS: '200',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
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
  await waitFor(() => stdout.includes('this tree will be restacked'));
  child.stdin.end(input);
  const [code] = (await once(child, 'exit')) as [number | null];
  return { status: code ?? 1, stdout, stderr };
}

function normalizePromptOutput(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\s+/g, ' ')
    .replace(/r estack/g, 'restack');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for merge prompt.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
