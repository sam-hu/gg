import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  command,
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

describe('sync', () => {
  test('fast-forwards trunk and restacks multiple independent stacks', async () => {
    await withTempRoot('sync', (root) => {
      const repo = initRepo(root);
      const bare = createBareRemote(root, repo);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'a.txt', 'a\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A']));
      write(repo, 'b.txt', 'b\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B']));
      expectSuccess(gg(repo, ['down', '2']));
      write(repo, 'x.txt', 'x\n');
      expectSuccess(gg(repo, ['bc', 'x', '--all', '-m', 'X']));
      write(repo, 'y.txt', 'y\n');
      expectSuccess(gg(repo, ['bc', 'y', '--all', '-m', 'Y']));

      const updater = path.join(root, 'updater');
      expectSuccess(command('git', ['clone', '-q', bare, updater], { cwd: root }));
      expectSuccess(git(updater, 'config', 'user.name', 'gg Test'));
      expectSuccess(git(updater, 'config', 'user.email', 'gg-test@example.invalid'));
      write(updater, 'remote.txt', 'remote advance\n');
      expectSuccess(git(updater, 'add', 'remote.txt'));
      expectSuccess(git(updater, 'commit', '-q', '-m', 'remote advance'));
      expectSuccess(git(updater, 'push', '-q', 'origin', 'main'));
      const remoteHead = head(updater, 'main');

      const result = gg(repo, ['sync']);
      expectSuccess(result);
      expect(result.stdout).toContain('main fast-forwarded');
      expect(head(repo, 'main')).toBe(remoteHead);
      expect(git(repo, 'merge-base', '--is-ancestor', 'main', 'a').status).toBe(0);
      expect(git(repo, 'merge-base', '--is-ancestor', 'a', 'b').status).toBe(0);
      expect(git(repo, 'merge-base', '--is-ancestor', 'main', 'x').status).toBe(0);
      expect(git(repo, 'merge-base', '--is-ancestor', 'x', 'y').status).toBe(0);
      expect(existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(false);
    });
  });

  test('refuses a diverged local trunk without force', async () => {
    await withTempRoot('sync-diverged', (root) => {
      const repo = initRepo(root);
      const bare = createBareRemote(root, repo);
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(git(repo, 'commit', '-q', '--allow-empty', '-m', 'local trunk'));
      const local = head(repo);

      const updater = path.join(root, 'updater');
      expectSuccess(command('git', ['clone', '-q', bare, updater], { cwd: root }));
      expectSuccess(git(updater, 'config', 'user.name', 'gg Test'));
      expectSuccess(git(updater, 'config', 'user.email', 'gg-test@example.invalid'));
      expectSuccess(git(updater, 'commit', '-q', '--allow-empty', '-m', 'remote trunk'));
      expectSuccess(git(updater, 'push', '-q', 'origin', 'main'));
      const result = gg(repo, ['sync']);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('could not be fast-forwarded');
      expect(head(repo)).toBe(local);
    });
  });

  test('deletes a merged branch and reparents its child without orphaning metadata', async () => {
    await withTempRoot('sync-merged-cleanup', (root) => {
      const repo = initRepo(root);
      createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'a.txt', 'a\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A']));
      const aHead = head(repo, 'a');
      write(repo, 'b.txt', 'b\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B']));
      expectSuccess(git(repo, 'push', '-q', 'origin', 'a:main'));
      const env = installFakeGh(root, {
        auth: true,
        nextNumber: 2,
        prs: [
          {
            number: 1,
            node_id: 'PR_merged_1',
            html_url: 'https://github.com/owner/repo/pull/1',
            state: 'closed',
            merged_at: '2026-01-01T00:00:00Z',
            draft: false,
            title: 'A',
            body: '',
            head: { ref: 'a' },
            base: { ref: 'main' },
            requested_reviewers: [],
            requested_teams: [],
          },
        ],
      });
      expectSuccess(gg(repo, ['sync', '--delete-all'], env));
      expect(head(repo, 'main')).toBe(aHead);
      expect(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/a').status).toBe(1);
      const db = new DatabaseSync(path.join(repo, '.git', '.gg_metadata.db'));
      expect(
        db.prepare('SELECT parent_branch_name FROM branch_metadata WHERE branch_name = ?').get('b'),
      ).toEqual({ parent_branch_name: 'main' });
      db.close();
      expect(gg(repo, ['log', 'short']).stdout).not.toContain('diverged');
    });
  });
});

describe('GitHub submission through an offline fake gh', () => {
  test('submits a full stack, bases PRs correctly, and updates without duplicates', async () => {
    await withTempRoot('submit', (root) => {
      const repo = initRepo(root);
      createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'a.txt', 'a\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A title']));
      write(repo, 'b.txt', 'b\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B title']));
      expectSuccess(gg(repo, ['bottom']));

      const env = installFakeGh(root, { auth: true, prs: [], nextNumber: 101 });
      const first = gg(repo, ['submit', '--stack'], { ...env, FORCE_COLOR: '1' });
      expectSuccess(first);
      expect(stripVTControlCharacters(first.stdout)).toContain(
        [
          'Submitting 2 branches',
          '  ├─ ✔ PR #101  a → main  created',
          '  │    https://github.com/owner/repo/pull/101',
          '  └─ ✔ PR #102  b → a  created',
          '       https://github.com/owner/repo/pull/102',
          '',
          '✔ Stack submitted.',
        ].join('\n'),
      );
      expect(first.stdout).toContain('https://github.com/owner/repo/pull/101');
      expect(first.stdout).toContain('\u001b[34m');
      expect(first.stdout).toContain('\u001b[4m');
      const afterFirst = stateFrom(env);
      expect(afterFirst.prs).toHaveLength(2);
      expect(afterFirst.prs.map((pr: any) => [pr.head.ref, pr.base.ref])).toEqual([
        ['a', 'main'],
        ['b', 'a'],
      ]);
      expect(afterFirst.prs.every((pr: any) => pr.body === '')).toBe(true);
      expect(afterFirst.prs.every((pr: any) => pr.draft)).toBe(true);
      expect(afterFirst.comments).toHaveLength(2);
      const aStackComment = afterFirst.comments.find(
        (comment: any) => comment.pullRequestNumber === 101,
      ).body;
      const bStackComment = afterFirst.comments.find(
        (comment: any) => comment.pullRequestNumber === 102,
      ).body;
      expect(aStackComment).toContain('### This pull request is part of a stack:');
      expect(aStackComment).not.toContain('### Stack');
      expect(aStackComment).toContain(
        '- [#102 B title](https://github.com/owner/repo/pull/102)\n- **[#101 A title](https://github.com/owner/repo/pull/101)** 👈 (This PR)\n- main',
      );
      expect(aStackComment).toContain(
        '- **[#101 A title](https://github.com/owner/repo/pull/101)** 👈 (This PR)',
      );
      expect(aStackComment).toContain('- [#102 B title](https://github.com/owner/repo/pull/102)');
      expect(aStackComment).not.toContain("The bolded pull request is the one you're viewing.");
      expect(aStackComment).toContain(
        '<sub>This stack was generated using [gg](https://github.com/sam-hu/gg)</sub>',
      );
      expect(bStackComment).toContain('- [#101 A title](https://github.com/owner/repo/pull/101)');
      expect(bStackComment).toContain(
        '- **[#102 B title](https://github.com/owner/repo/pull/102)** 👈 (This PR)',
      );
      expect(gg(repo, ['log', 'short']).stdout).toContain('submitted');

      const second = gg(repo, ['submit', '--stack'], env);
      expectSuccess(second);
      expect(second.stdout).toBe('Stack is unchanged since the last submit.\n');
      expect(stateFrom(env).prs).toHaveLength(2);
      expect(stateFrom(env).comments).toHaveLength(2);
      expect(stateFrom(env).calls).toHaveLength(afterFirst.calls.length);

      const changed = stateFrom(env);
      changed.prs[0].body = 'Stacked branch: `a`\n\nBase: `main`\n\nHuman-authored notes.';
      changed.prs[1].body = 'Stacked branch: `b`\n\nBase: `a`';
      changed.prs[1].base.ref = 'main';
      const statePath = env.GG_FAKE_GH_STATE!;
      writeFileSync(statePath, JSON.stringify(changed, null, 2));
      const updated = gg(repo, ['submit', '--stack', '--always'], env);
      expectSuccess(updated);
      expect(stripVTControlCharacters(updated.stdout)).toContain(
        '├─ ✔ PR #101  a → main  updated',
      );
      expect(stripVTControlCharacters(updated.stdout)).toContain('└─ ✔ PR #102  b → a  updated');
      expect(stateFrom(env).prs[1].base.ref).toBe('a');
      expect(stateFrom(env).prs.map((pr: any) => pr.body)).toEqual(['Human-authored notes.', '']);

      expectSuccess(
        gg(
          repo,
          [
            'submit',
            '--stack',
            '--publish',
            '--reviewers',
            'alice,bob',
            '--team-reviewers',
            'core',
            '--comment',
            'ready',
            '--merge-when-ready',
          ],
          env,
        ),
      );
      const advanced = stateFrom(env);
      expect(advanced.prs[0].requested_reviewers.map((reviewer: any) => reviewer.login)).toEqual([
        'alice',
        'bob',
      ]);
      expect(advanced.prs[0].requested_teams.map((team: any) => team.slug)).toEqual(['core']);
      expect(
        advanced.comments.filter((comment: any) => comment.body.includes('gg-stack-comment')),
      ).toHaveLength(2);
      expect(advanced.comments.filter((comment: any) => comment.body === 'ready')).toHaveLength(2);
      expect(
        advanced.calls.filter(
          (call: any) => call.endpoint === 'graphql' && call.body.query.includes('AutoMerge'),
        ),
      ).toHaveLength(2);

      expectSuccess(git(repo, 'commit', '-q', '--allow-empty', '-m', 'post-submit change'));
      expect(gg(repo, ['log', 'short']).stdout).toContain('changed since submit');
    });
  });

  test('automatically rewrites a diverged remote branch with a pinned lease', async () => {
    await withTempRoot('submit-rewrite', (root) => {
      const repo = initRepo(root);
      const bare = createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'feature.txt', 'first\n');
      expectSuccess(gg(repo, ['bc', 'feature', '--all', '-m', 'Feature']));
      const env = installFakeGh(root, { auth: true, prs: [], nextNumber: 1 });
      expectSuccess(gg(repo, ['submit'], env));
      const originalRemoteHead = head(bare, 'refs/heads/feature');

      write(repo, 'feature.txt', 'rewritten\n');
      expectSuccess(gg(repo, ['ca', '--all', '-m', 'Feature rewritten']));
      const rewrittenHead = head(repo, 'feature');
      expect(rewrittenHead).not.toBe(originalRemoteHead);

      expectSuccess(gg(repo, ['submit'], env));
      expect(head(bare, 'refs/heads/feature')).toBe(rewrittenHead);
      expect(stateFrom(env).prs).toHaveLength(1);
    });
  });

  test('refreshes every affected stack comment after upstack additions and moves', async () => {
    await withTempRoot('submit-stack-comments', (root) => {
      const repo = initRepo(root);
      createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));

      write(repo, 'a.txt', 'a\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A title']));
      write(repo, 'b.txt', 'b\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B title']));
      expectSuccess(gg(repo, ['bottom']));

      const env = installFakeGh(root, { auth: true, prs: [], nextNumber: 1 });
      expectSuccess(gg(repo, ['submit', '--stack'], env));

      expectSuccess(git(repo, 'switch', '-q', 'main'));
      write(repo, 'x.txt', 'x\n');
      expectSuccess(gg(repo, ['bc', 'x', '--all', '-m', 'X title']));
      expectSuccess(gg(repo, ['submit'], env));

      expectSuccess(git(repo, 'switch', '-q', 'b'));
      write(repo, 'c.txt', 'c\n');
      expectSuccess(gg(repo, ['bc', 'c', '--all', '-m', 'C title']));
      expectSuccess(gg(repo, ['submit'], env));

      const afterAddition = stateFrom(env);
      expect(afterAddition.comments).toHaveLength(4);
      for (const number of [1, 2, 4]) {
        const comment = afterAddition.comments.find(
          (candidate: any) => candidate.pullRequestNumber === number,
        );
        expect(comment.body).toContain('[#1 A title](https://github.com/owner/repo/pull/1)');
        expect(comment.body).toContain('[#2 B title](https://github.com/owner/repo/pull/2)');
        expect(comment.body).toContain('[#4 C title](https://github.com/owner/repo/pull/4)');
      }

      const damaged = stateFrom(env);
      damaged.comments.find((comment: any) => comment.pullRequestNumber === 2).body =
        '<!-- gg-stack-comment -->\nstale';
      damaged.comments = damaged.comments.filter((comment: any) => comment.pullRequestNumber !== 4);
      writeFileSync(env.GG_FAKE_GH_STATE!, JSON.stringify(damaged, null, 2));
      expectSuccess(git(repo, 'commit', '-q', '--allow-empty', '-m', 'Update C'));
      expectSuccess(gg(repo, ['submit'], env));

      const healed = stateFrom(env);
      expect(healed.comments).toHaveLength(4);
      expect(
        healed.comments.find((comment: any) => comment.pullRequestNumber === 2).body,
      ).toContain('[#4 Update C](https://github.com/owner/repo/pull/4)');
      expect(
        healed.comments.find((comment: any) => comment.pullRequestNumber === 4).body,
      ).toContain('- **[#4 Update C](https://github.com/owner/repo/pull/4)**');

      expectSuccess(gg(repo, ['move', '--source', 'b', '--onto', 'x']));
      expectSuccess(gg(repo, ['submit', '--branch', 'b', '--stack'], env));

      const afterMove = stateFrom(env);
      expect(afterMove.comments).toHaveLength(4);
      const aComment = afterMove.comments.find(
        (comment: any) => comment.pullRequestNumber === 1,
      ).body;
      expect(aComment).toContain('- **[#1 A title](https://github.com/owner/repo/pull/1)**');
      expect(aComment).not.toContain('#2 B title');
      for (const number of [2, 3, 4]) {
        const comment = afterMove.comments.find(
          (candidate: any) => candidate.pullRequestNumber === number,
        );
        expect(comment.body).toContain('[#3 X title](https://github.com/owner/repo/pull/3)');
        expect(comment.body).toContain('[#2 B title](https://github.com/owner/repo/pull/2)');
        expect(comment.body).toContain('[#4 Update C](https://github.com/owner/repo/pull/4)');
      }
    });
  });

  test('submits only current and downstack by default', async () => {
    await withTempRoot('submit-scope', (root) => {
      const repo = initRepo(root);
      createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'a']));
      expectSuccess(gg(repo, ['bc', 'b']));
      const env = installFakeGh(root, { auth: true, prs: [], nextNumber: 1 });
      expectSuccess(gg(repo, ['submit'], env));
      expect(stateFrom(env).prs.map((pr: any) => pr.head.ref)).toEqual(['a', 'b']);
    });
  });

  test('fails authentication before pushing', async () => {
    await withTempRoot('submit-auth', (root) => {
      const repo = initRepo(root);
      const bare = createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      expectSuccess(gg(repo, ['bc', 'a']));
      const env = {
        ...installFakeGh(root, { auth: false, prs: [], nextNumber: 1 }),
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      };
      const result = gg(repo, ['submit'], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('GitHub authentication is required');
      expect(git(bare, 'show-ref', '--verify', '--quiet', 'refs/heads/a').status).toBe(1);
    });
  });

  test('plans a dry-run restack without mutating refs or remotes', async () => {
    await withTempRoot('submit-dry-restack', (root) => {
      const repo = initRepo(root);
      const bare = createBareRemote(root, repo);
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/owner/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'a.txt', 'a\n');
      expectSuccess(gg(repo, ['bc', 'a', '--all', '-m', 'A']));
      write(repo, 'b.txt', 'b\n');
      expectSuccess(gg(repo, ['bc', 'b', '--all', '-m', 'B']));
      expectSuccess(gg(repo, ['down']));
      expectSuccess(git(repo, 'commit', '-q', '--allow-empty', '-m', 'advance parent'));
      expectSuccess(gg(repo, ['up']));
      const before = head(repo, 'b');
      const env = installFakeGh(root, { auth: true, prs: [], nextNumber: 1 });
      const result = gg(repo, ['submit', '--stack', '--dry-run', '--restack'], env);
      expectSuccess(result);
      expect(result.stdout).toContain('Would restack b before submitting.');
      expect(head(repo, 'b')).toBe(before);
      expect(git(bare, 'show-ref', '--verify', '--quiet', 'refs/heads/a').status).toBe(1);
      expect(stateFrom(env).prs).toHaveLength(0);
    });
  });

  test('uses a distinct pushurl fork for remote inspection, pushes, and PR heads', async () => {
    await withTempRoot('submit-fork-pushurl', (root) => {
      const repo = initRepo(root);
      const upstream = createBareRemote(root, repo);
      const fork = path.join(root, 'fork.git');
      expectSuccess(
        command('git', ['init', '-q', '--bare', '--initial-branch=main', fork], { cwd: root }),
      );
      expectSuccess(git(repo, 'remote', 'set-url', '--push', 'origin', fork));
      expectSuccess(git(repo, 'config', 'gg.githubRepository', 'github.com/upstream/repo'));
      expectSuccess(git(repo, 'config', 'gg.githubHeadRepository', 'github.com/fork/repo'));
      expectSuccess(gg(repo, ['init', '--trunk', 'main']));
      write(repo, 'fork.txt', 'fork\n');
      expectSuccess(gg(repo, ['bc', 'fork-branch', '--all', '-m', 'Fork branch']));
      const env = installFakeGh(root, { auth: true, prs: [], nextNumber: 1 });
      expectSuccess(gg(repo, ['submit'], env));

      expect(
        git(upstream, 'show-ref', '--verify', '--quiet', 'refs/heads/fork-branch').status,
      ).toBe(1);
      expectSuccess(git(fork, 'show-ref', '--verify', '--quiet', 'refs/heads/fork-branch'));
      const state = stateFrom(env);
      expect(state.prs).toHaveLength(1);
      expect(
        state.calls.some(
          (call: any) =>
            call.method === 'GET' && String(call.endpoint).includes('head=fork%3Afork-branch'),
        ),
      ).toBe(true);
    });
  });
});
