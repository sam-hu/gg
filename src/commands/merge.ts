import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { deleteTrackedBranch } from '../branch-cleanup.js';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import {
  authenticatedGitHubClient,
  resolveSubmissionRepository,
  type PullRequest,
} from '../github.js';
import { renderMoveTree } from '../move-tree.js';
import { RestackEngine } from '../restack.js';
import { renderRelation, renderRestackResult } from '../restack-output.js';
import { submit } from './submit.js';

export async function mergeBottomBranch(context: RepositoryContext): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  await engine.ensureNotBlocked();

  const graph = new StackGraph(git, store);
  const current = git.branch();
  graph.require(current);
  if (current === graph.trunk) throw ggError('Cannot merge the trunk branch.');

  const lineage = graph.ancestors(current, true);
  if (!lineage.includes(graph.trunk)) {
    throw ggError(`Tracked branch ${current} is not connected to trunk ${graph.trunk}.`);
  }
  const bottom = lineage.filter((branch) => branch !== graph.trunk).at(-1)!;

  context.requireInteractive();
  const visibleBranches = [...lineage, ...graph.descendants(current)];
  output.lines(renderMoveTree(graph, visibleBranches, current));
  const approved = await confirm({
    message: `${bottom} will be merged into ${graph.trunk} and this tree will be restacked. Confirm?`,
    default: true,
  });
  if (!approved) {
    output.line('Merge cancelled.');
    return;
  }

  const descendants = graph.descendants(bottom);
  preflightLocalMutation(context, [graph.trunk, bottom, ...descendants]);

  const repository = resolveSubmissionRepository(git, graph.trunk, bottom);
  if (!repository) throw ggError('Could not determine the GitHub repository for this stack.');

  const remoteTrunk = `${repository.baseRemote}/${graph.trunk}`;
  fetchTrunk(context, repository.baseRemote, graph.trunk);
  const remoteBefore = git.tryHead(remoteTrunk);
  if (!remoteBefore) throw ggError(`Remote branch ${remoteTrunk} does not exist.`);
  const localBefore = git.head(graph.trunk);
  if (!git.isAncestor(localBefore, remoteBefore)) {
    throw ggError(
      `Local trunk ${graph.trunk} has diverged from ${remoteTrunk}. Run gg sync before merging.`,
    );
  }

  const client = await authenticatedGitHubClient(repository);
  const pullRequests = await client.listForHead(repository, bottom);
  const bottomHead = git.head(bottom);
  const pullRequest = selectPullRequest(pullRequests, bottom, graph.trunk, bottomHead);
  let mergeSha: string | undefined;
  if (pullRequest.state === 'OPEN') {
    mergeSha = (await client.merge(repository, pullRequest, bottomHead)).sha;
  }

  fetchTrunk(context, repository.baseRemote, graph.trunk);
  const remoteAfter = git.tryHead(remoteTrunk);
  if (!remoteAfter) throw ggError(`Remote branch ${remoteTrunk} does not exist after merging.`);
  if (mergeSha && !git.isAncestor(mergeSha, remoteAfter)) {
    throw ggError(`Merged PR #${pullRequest.number}, but ${remoteTrunk} has not updated yet.`);
  }
  if (!git.isAncestor(localBefore, remoteAfter)) {
    throw ggError(
      `Merged PR #${pullRequest.number}, but local trunk ${graph.trunk} cannot be fast-forwarded to ${remoteTrunk}.`,
    );
  }

  git.updateRef(graph.trunk, remoteAfter, localBefore);
  store.updateBranchRevision(graph.trunk, remoteAfter);
  const { reparentedChildren: remainingRoots } = deleteTrackedBranch(
    context,
    bottom,
    graph.trunk,
    bottomHead,
  );

  output.line();
  output.line(
    `${chalk.green('✔')} ${chalk.bold(
      pullRequest.state === 'OPEN'
        ? `Merged PR #${pullRequest.number}`
        : `PR #${pullRequest.number} was already merged`,
    )}  ${renderRelation(bottom, graph.trunk)}`,
  );

  if (descendants.length > 0) {
    const relations = descendants.map((branch) => {
      const parent = store.get(branch)?.parentBranchName;
      if (!parent) throw ggError(`Tracked metadata for ${branch} has no parent.`);
      return { branch, parent };
    });
    await engine.runQueue(descendants, { command: 'merge', haltOnConflict: true, quiet: true });
    renderRestackResult(output, relations, { leadingBlank: true, showReady: false });
    for (const root of remainingRoots) {
      await submit(context, { branch: root, stack: true });
    }
  } else {
    output.line();
    renderRestackResult(output, []);
  }
}

function selectPullRequest(
  pullRequests: PullRequest[],
  branch: string,
  trunk: string,
  expectedHead: string,
): PullRequest {
  const open = pullRequests.filter((pullRequest) => pullRequest.state === 'OPEN');
  if (open.length > 1) {
    throw ggError(`Multiple open pull requests found for branch ${branch}.`);
  }
  const candidate = open[0] ?? pullRequests.find((pullRequest) => pullRequest.state === 'MERGED');
  if (!candidate) throw ggError(`No open pull request found for branch ${branch}.`);
  if (!candidate.headSha) {
    throw ggError(`GitHub did not return a head SHA for PR #${candidate.number}.`);
  }
  if (candidate.headSha !== expectedHead) {
    throw ggError(
      `PR #${candidate.number} points to ${candidate.headSha}, but local branch ${branch} is at ${expectedHead}. Refusing to merge or delete it.`,
    );
  }
  if (candidate.baseRef !== trunk) {
    throw ggError(
      `PR #${candidate.number} for ${branch} targets ${candidate.baseRef}, not trunk ${trunk}.`,
    );
  }
  return candidate;
}

function preflightLocalMutation(context: RepositoryContext, branches: string[]): void {
  if (context.git.hasAnyChanges()) {
    throw ggError('Cannot merge while the worktree has changes. Commit or stash them first.');
  }
  for (const branch of new Set(branches)) {
    if (context.git.isBranchCheckedOutElsewhere(branch)) {
      throw ggError(`Cannot merge because ${branch} is checked out in another worktree.`);
    }
  }
}

function fetchTrunk(context: RepositoryContext, remote: string, trunk: string): void {
  context.git.run([
    'fetch',
    '--quiet',
    remote,
    `+refs/heads/${trunk}:refs/remotes/${remote}/${trunk}`,
  ]);
}
