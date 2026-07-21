import { confirm } from '@inquirer/prompts';
import { deleteTrackedBranch } from '../branch-cleanup.js';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import {
  authenticatedGitHubClient,
  resolveGitHubRepository,
  resolveRemote,
  SubmissionRepositoryResolver,
  type GitHubRepository,
  type PullRequest,
} from '../github.js';
import { RestackEngine } from '../restack.js';

export interface SyncOptions {
  restack?: boolean;
  force?: boolean;
  deleteAll?: boolean;
  all?: boolean;
}

interface PrState {
  byBranch: Map<string, PullRequest[]>;
}

export async function sync(context: RepositoryContext, options: SyncOptions): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  await engine.ensureNotBlocked();
  let graph = new StackGraph(git, store);
  const remote = resolveRemote(git, graph.trunk);
  const repository = resolveGitHubRepository(git, remote);
  const prState = repository ? await loadPrState(context, graph, repository) : undefined;

  output.line('🌲 Fetching branches from remote...');
  git.run(['fetch', remote.name]);
  const remoteTrunk = `${remote.name}/${graph.trunk}`;
  const remoteHead = git.tryHead(remoteTrunk);
  if (!remoteHead) throw ggError(`Remote branch ${remoteTrunk} does not exist.`);
  const localHead = git.head(graph.trunk);
  if (localHead === remoteHead) {
    output.line(`${graph.trunk} is up to date.`);
  } else if (git.isAncestor(localHead, remoteHead)) {
    moveTrunk(context, graph.trunk, remoteHead, localHead);
    output.line(`${graph.trunk} fast-forwarded to ${remoteHead}.`);
  } else {
    output.warning(`${graph.trunk} could not be fast-forwarded.`);
    let overwrite = options.force ?? false;
    if (!overwrite && context.interactive) {
      overwrite = await confirm({
        message: `Overwrite ${graph.trunk} with the version from remote?`,
        default: true,
      });
    }
    if (!overwrite) throw ggError(`${graph.trunk} could not be fast-forwarded.`);
    moveTrunk(context, graph.trunk, remoteHead, localHead);
    output.line(`${graph.trunk} set to ${remoteHead}.`);
  }
  store.updateBranchRevision(graph.trunk, remoteHead);

  const skippedMergedRoots = prState
    ? await cleanupPullRequests(context, graph, prState, options)
    : new Set<string>();
  if (prState) {
    graph = new StackGraph(git, store);
  }

  if (options.restack !== false) {
    output.line('🥞 Restacking branches...');
    const queue = git.withRefSnapshot(() =>
      graph
        .allRestackOrder()
        .filter(
          (branch) =>
            ![...skippedMergedRoots].some(
              (root) => branch === root || graph.ancestors(branch).includes(root),
            ),
        ),
    );
    await engine.runQueueWithoutJournal(queue, (branch) => {
      output.warning(`${branch} could not be restacked cleanly.`);
      output.line(`You can resolve conflicts with gg restack --branch ${branch}.`);
    });
  }
}

async function loadPrState(
  context: RepositoryContext,
  graph: StackGraph,
  fallbackRepository: GitHubRepository,
): Promise<PrState> {
  const byBranch = new Map<string, PullRequest[]>();
  const resolver = new SubmissionRepositoryResolver(context.git, graph.trunk);
  const groups = new Map<string, { repository: GitHubRepository; branches: string[] }>();
  for (const branch of graph.trackedBranches()) {
    if (branch === graph.trunk) continue;
    const repository = resolver.resolve(branch) ?? fallbackRepository;
    const key = `${repository.host}/${repository.owner}/${repository.name}/${repository.headOwner}`;
    const group = groups.get(key) ?? { repository, branches: [] };
    group.branches.push(branch);
    groups.set(key, group);
  }
  for (const { repository, branches } of groups.values()) {
    const client = await authenticatedGitHubClient(repository);
    const pullRequests = await client.listPullRequests(repository);
    for (const branch of branches) {
      byBranch.set(
        branch,
        pullRequests.filter(
          (pullRequest) =>
            pullRequest.headRef === branch &&
            (!pullRequest.headOwner || pullRequest.headOwner === repository.headOwner),
        ),
      );
    }
  }
  return { byBranch };
}

async function cleanupPullRequests(
  context: RepositoryContext,
  graph: StackGraph,
  state: PrState,
  options: SyncOptions,
): Promise<Set<string>> {
  const skippedMergedRoots = new Set<string>();
  const candidates: Array<{ branch: string; pullRequest: PullRequest }> = [];
  for (const [branch, pullRequests] of state.byBranch) {
    if (pullRequests.some((pullRequest) => pullRequest.state === 'OPEN')) continue;
    const closed = pullRequests.filter(
      (pullRequest) => pullRequest.state === 'MERGED' || pullRequest.state === 'CLOSED',
    );
    const malformed = closed.find((pullRequest) => !pullRequest.headSha);
    if (malformed) {
      throw ggError(
        `GitHub did not return a head SHA for PR #${malformed.number}; refusing to clean up ${branch}.`,
      );
    }
    const localHead = context.git.tryHead(branch);
    if (!localHead) continue;
    const matching = closed.find((pullRequest) => pullRequest.headSha === localHead);
    if (matching) candidates.push({ branch, pullRequest: matching });
  }
  if (candidates.length === 0) return skippedMergedRoots;
  context.output.line('🧹 Cleaning up branches with merged/closed PRs...');
  for (const candidate of candidates) {
    const row = context.store.get(candidate.branch);
    if (!row?.parentBranchName || !context.git.branchExists(candidate.branch)) continue;
    let approved = options.deleteAll ?? false;
    if (!approved && context.interactive) {
      approved = await confirm({
        message: `PR #${candidate.pullRequest.number} for ${candidate.branch} is ${candidate.pullRequest.state.toLowerCase()}. Delete this branch?`,
        default: true,
      });
    }
    if (!approved) {
      if (candidate.pullRequest.state === 'MERGED') {
        skippedMergedRoots.add(candidate.branch);
        context.output.line(
          `Did not restack branch ${candidate.branch} because it has been merged.`,
        );
      }
      continue;
    }
    const { previousRevision, reparentedChildren } = deleteTrackedBranch(
      context,
      candidate.branch,
      row.parentBranchName,
      candidate.pullRequest.headSha,
    );
    for (const child of reparentedChildren) {
      context.output.line(`Set parent of ${child} to ${row.parentBranchName}.`);
    }
    context.output.line(
      `Deleted branch ${candidate.branch} for PR #${candidate.pullRequest.number} (previously at ${previousRevision})`,
    );
  }
  return skippedMergedRoots;
}

function moveTrunk(
  context: RepositoryContext,
  trunk: string,
  next: string,
  previous: string,
): void {
  if (context.git.tryBranch() === trunk) {
    if (context.git.hasStagedChanges()) {
      throw ggError(`Cannot update checked out trunk ${trunk} while changes are staged.`);
    }
    context.git.run(['reset', '-q', '--keep', next]);
  } else {
    if (context.git.isBranchCheckedOutElsewhere(trunk)) {
      throw ggError(`Cannot update ${trunk} because it is checked out in another worktree.`);
    }
    context.git.updateRef(trunk, next, previous);
  }
}
