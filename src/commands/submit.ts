import { confirm, editor, input } from '@inquirer/prompts';
import chalk from 'chalk';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import {
  authenticatedGitHubClient,
  resolveSubmissionRepository,
  type GitHubClient,
  type GitHubRepository,
  type PullRequest,
} from '../github.js';
import { RestackEngine } from '../restack.js';

export interface SubmitOptions {
  draft?: boolean;
  publish?: boolean;
  restack?: boolean;
  edit?: boolean;
  editTitle?: boolean;
  editDescription?: boolean;
  reviewers?: string;
  teamReviewers?: string;
  dryRun?: boolean;
  confirm?: boolean;
  updateOnly?: boolean;
  force?: boolean;
  always?: boolean;
  branch?: string;
  mergeWhenReady?: boolean;
  rerequestReview?: boolean;
  view?: boolean;
  comment?: string | boolean;
  cli?: boolean;
  web?: boolean;
  targetTrunk?: string;
  ignoreOutOfSyncTrunk?: boolean;
  stack?: boolean;
}

interface SubmitPlanItem {
  branch: string;
  base: string;
  localHead: string;
  title: string;
  body: string;
  openPullRequest?: PullRequest;
}

export async function submit(context: RepositoryContext, options: SubmitOptions): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  engine.ensureNotBlocked();
  let graph = new StackGraph(git, store);
  const anchor = options.branch ?? git.branch();
  graph.require(anchor);
  if (anchor === graph.trunk) {
    throw ggError(`Cannot perform this operation on the trunk branch.\n\n${graph.trunk}`);
  }
  if (
    !context.interactive &&
    (options.confirm ||
      options.edit === true ||
      options.cli ||
      options.editTitle === true ||
      options.editDescription === true ||
      options.comment === true)
  ) {
    context.requireInteractive();
  }

  if (options.dryRun) {
    output.line(
      "Running submit in 'dry-run' mode. No branches will be pushed and no PRs will be opened or updated.",
    );
  }
  if (!context.interactive) {
    const suffix =
      options.draft || options.publish ? '' : ' and new PRs will be created in draft mode';
    output.line(
      `Running in non-interactive mode. Inline prompts to fill PR fields will be skipped${suffix}.`,
    );
  }
  output.line('🥞 Validating that this gg stack is ready to submit...');

  const repository = resolveSubmissionRepository(git, graph.trunk, anchor);
  if (!repository) {
    throw ggError(
      'The trunk and push remotes could not be resolved as compatible GitHub repositories.',
    );
  }
  const client = await authenticatedGitHubClient(repository);
  validateRemoteTrunk(context, repository, graph.trunk, options);

  const validation = graph.refresh();
  const invalidBranches = new Set([...validation.diverged, ...validation.missing]);
  graph = new StackGraph(git, store);

  if (options.restack) {
    if (options.dryRun) {
      output.line(`Would restack ${anchor} before submitting.`);
    } else {
      await engine.restack(anchor, options.stack ? 'stack' : 'downstack', 'submit --restack');
      graph = new StackGraph(git, store);
    }
  }

  const branches = submitScope(graph, anchor, options.stack ?? false);
  const invalidInScope = branches.filter((branch) => invalidBranches.has(branch));
  if (invalidInScope.length > 0) {
    throw ggError(
      `The following tracked branches have invalid metadata or history: ${invalidInScope.join(', ')}. Repair or retrack them before submission.`,
    );
  }
  const stale = branches.filter(
    (branch) => graph.needsRestack(branch) && !(options.dryRun && options.restack),
  );
  if (stale.length > 0) {
    throw ggError(
      `The following branches need to be restacked before submission: ${stale.join(', ')}. Run gg restack.`,
    );
  }

  const plan: SubmitPlanItem[] = [];
  for (const branch of branches) {
    const open = (await client.listForHead(repository, branch)).filter((pr) => pr.state === 'OPEN');
    if (open.length > 1) {
      throw ggError(
        `Multiple open pull requests exist for ${branch}:\n${open.map((pr) => `${pr.number}: ${pr.url}`).join('\n')}`,
      );
    }
    if (options.updateOnly && open.length === 0) continue;
    const parent = graph.parent(branch);
    if (!parent) continue;
    plan.push({
      branch,
      base: parent === graph.trunk ? (options.targetTrunk ?? graph.trunk) : parent,
      localHead: git.head(branch),
      title: git.capture(['show', '-s', '--format=%s', branch]),
      body: `Stacked branch: \`${branch}\`\n\nBase: \`${
        parent === graph.trunk ? (options.targetTrunk ?? graph.trunk) : parent
      }\``,
      ...(open[0] ? { openPullRequest: open[0] } : {}),
    });
  }

  for (const item of plan) await editPlanItem(context, item, options);

  for (const item of plan) {
    output.line(
      `${options.dryRun ? 'Would submit' : 'Submitting'} ${item.branch} -> ${item.base}${
        item.openPullRequest ? ` (update PR #${item.openPullRequest.number})` : ' (new PR)'
      }`,
    );
  }
  if (options.dryRun) return;

  const submissionComment = await resolveComment(context, options.comment);

  if (options.confirm) {
    context.requireInteractive();
    const approved = await confirm({ message: `Submit ${plan.length} branch(es)?`, default: true });
    if (!approved) throw ggError('Submit cancelled.');
  }

  const urls: string[] = [];
  for (const item of plan) {
    await pushBranch(context, repository, item, options);
    const pullRequest = await reconcilePullRequest(context, client, repository, item, options);
    const reviewers = splitList(options.reviewers);
    const teams = splitList(options.teamReviewers);
    if (options.rerequestReview && item.openPullRequest) {
      reviewers.push(...(await client.reviewersForRerequest(repository, item.openPullRequest)));
      reviewers.push(...item.openPullRequest.requestedReviewers);
      teams.push(...item.openPullRequest.requestedTeams);
    }
    await client.requestReviewers(
      repository,
      pullRequest,
      [...new Set(reviewers)],
      [...new Set(teams)],
    );
    if (submissionComment) await client.comment(repository, pullRequest, submissionComment);
    if (options.mergeWhenReady) await client.enableAutoMerge(repository, pullRequest);
    const row = store.get(item.branch);
    if (row) {
      row.lastSubmittedVersion = item.localHead;
      store.put(row);
    }
    urls.push(pullRequest.url);
    output.line(chalk.blue.underline(pullRequest.url));
  }

  if (urls.length === 0) output.line('No branches required submission.');
  if (options.view || options.web) {
    output.line('Open the pull request URLs above in your browser.');
  }
}

function submitScope(graph: StackGraph, anchor: string, includeDescendants: boolean): string[] {
  const downstack = graph
    .ancestors(anchor, true)
    .filter((branch) => branch !== graph.trunk)
    .reverse();
  if (!includeDescendants) return downstack;
  const seen = new Set(downstack);
  return [
    ...downstack,
    ...graph.descendants(anchor).filter((branch) => {
      if (seen.has(branch)) return false;
      seen.add(branch);
      return true;
    }),
  ];
}

async function pushBranch(
  context: RepositoryContext,
  repository: GitHubRepository,
  item: SubmitPlanItem,
  options: SubmitOptions,
): Promise<void> {
  const { git } = context;
  const remoteRef = `refs/heads/${item.branch}`;
  const result = git.run(['ls-remote', '--heads', repository.pushUrl, remoteRef], {
    allowFailure: true,
  });
  if (result.status !== 0) throw ggError(`Could not inspect remote branch ${item.branch}.`);
  const remoteHead = result.stdout.trim().split(/\s+/)[0] || undefined;
  if (remoteHead === item.localHead && !options.always) return;
  const refspec = `refs/heads/${item.branch}:${remoteRef}`;
  if (!remoteHead || git.isAncestor(remoteHead, item.localHead)) {
    git.run(['push', repository.remote, refspec]);
    return;
  }

  let approvedLease = options.force ?? false;
  if (!approvedLease && context.interactive) {
    approvedLease = await confirm({
      message: `Remote branch ${item.branch} must be rewritten with force-with-lease. Continue?`,
      default: false,
    });
  }
  if (!approvedLease) {
    throw ggError(
      `Submitting ${item.branch} requires rewriting its remote branch. Rerun with --force or confirm interactively.`,
    );
  }
  git.run(['push', `--force-with-lease=${remoteRef}:${remoteHead}`, repository.remote, refspec]);
}

async function reconcilePullRequest(
  context: RepositoryContext,
  client: GitHubClient,
  repository: GitHubRepository,
  item: SubmitPlanItem,
  options: SubmitOptions,
): Promise<PullRequest> {
  const { title, body } = item;
  let pullRequest: PullRequest;
  if (item.openPullRequest) {
    const changes: { base?: string; title?: string; body?: string } = {};
    if (item.openPullRequest.baseRef !== item.base) changes.base = item.base;
    if (
      options.edit !== false &&
      options.editTitle !== false &&
      item.openPullRequest.title !== title
    ) {
      changes.title = title;
    }
    if (
      options.edit !== false &&
      options.editDescription !== false &&
      item.openPullRequest.body !== body
    ) {
      changes.body = body;
    }
    pullRequest =
      Object.keys(changes).length > 0
        ? await client.update(repository, item.openPullRequest.number, changes)
        : item.openPullRequest;
  } else {
    pullRequest = await client.create(repository, {
      title,
      body,
      head: `${repository.headOwner}:${item.branch}`,
      base: item.base,
      draft: options.publish ? false : (options.draft ?? !context.interactive),
    });
  }
  if (options.publish) await client.publish(repository, pullRequest);
  return pullRequest;
}

async function editPlanItem(
  context: RepositoryContext,
  item: SubmitPlanItem,
  options: SubmitOptions,
): Promise<void> {
  const editTitle = options.edit === true || options.cli || options.editTitle === true;
  const editBody = options.edit === true || options.cli || options.editDescription === true;
  if (editTitle) {
    item.title = await input({
      message: `Title for ${item.branch}`,
      default: item.openPullRequest?.title || item.title,
    });
  }
  if (editBody) {
    item.body = await editor({
      message: `Description for ${item.branch}`,
      default: item.openPullRequest?.body || item.body,
    });
  }
}

function validateRemoteTrunk(
  context: RepositoryContext,
  repository: GitHubRepository,
  trunk: string,
  options: SubmitOptions,
): void {
  if (options.ignoreOutOfSyncTrunk) return;
  const remoteTrunk = options.targetTrunk ?? trunk;
  const result = context.git.run(
    ['ls-remote', '--heads', repository.baseRemote, `refs/heads/${remoteTrunk}`],
    { allowFailure: true },
  );
  if (result.status !== 0) throw ggError(`Could not inspect remote trunk ${remoteTrunk}.`);
  const remoteHead = result.stdout.trim().split(/\s+/)[0];
  if (!remoteHead) throw ggError(`Remote trunk ${remoteTrunk} does not exist.`);
  if (remoteTrunk === trunk && remoteHead !== context.git.head(trunk)) {
    throw ggError(
      `Local trunk ${trunk} is out of sync with ${repository.baseRemote}/${remoteTrunk}. Run gg sync or pass --ignore-out-of-sync-trunk.`,
    );
  }
}

function splitList(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

async function resolveComment(
  context: RepositoryContext,
  value: string | boolean | undefined,
): Promise<string | undefined> {
  if (typeof value === 'string') return value;
  if (!value) return undefined;
  context.requireInteractive();
  return input({ message: 'Pull request comment' });
}
