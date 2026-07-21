import { confirm, editor, input } from '@inquirer/prompts';
import chalk from 'chalk';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import type { Git } from '../git.js';
import { StackGraph } from '../graph.js';
import {
  authenticatedGitHubClient,
  resolveSubmissionRepository,
  type GitHubClient,
  type GitHubRepository,
  type PullRequest,
} from '../github.js';
import type { Output } from '../output.js';
import { RestackEngine } from '../restack.js';
import { renderRelation } from '../restack-output.js';
import { pluralize } from '../text.js';

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
  lastSubmittedVersion: string | null;
  codeUnchanged: boolean;
  title: string;
  body: string;
  openPullRequest?: PullRequest;
}

const STACK_COMMENT_MARKER = '<!-- gg-stack-comment -->';

export async function submit(context: RepositoryContext, options: SubmitOptions): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  await engine.ensureNotBlocked();
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

  const unchanged = git.withRefSnapshot(() => {
    const branches = submitScope(graph, anchor, options.stack ?? false);
    return canSkipUnchangedSubmit(git, graph, branches, options);
  });
  if (unchanged) {
    output.line('Stack is unchanged since the last submit.');
    return;
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
  output.line('🥞 Validating stack...');

  const repository = resolveSubmissionRepository(git, graph.trunk, anchor);
  if (!repository) {
    throw ggError(
      'The trunk and push remotes could not be resolved as compatible GitHub repositories.',
    );
  }
  const client = await authenticatedGitHubClient(repository);
  validateRemoteTrunk(context, repository, graph.trunk, options);
  const pullRequestInventory = await client.listPullRequests(repository);

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

  const branches = git.withRefSnapshot(() => submitScope(graph, anchor, options.stack ?? false));
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
    const open = pullRequestInventory.filter(
      (pullRequest) =>
        pullRequest.state === 'OPEN' &&
        pullRequest.headRef === branch &&
        (!pullRequest.headOwner || pullRequest.headOwner === repository.headOwner),
    );
    if (open.length > 1) {
      throw ggError(
        `Multiple open pull requests exist for ${branch}:\n${open.map((pr) => `${pr.number}: ${pr.url}`).join('\n')}`,
      );
    }
    if (options.updateOnly && open.length === 0) continue;
    const parent = graph.parent(branch);
    if (!parent) continue;
    const openPullRequest = open[0];
    const localHead = git.head(branch);
    const metadata = graph.get(branch);
    const base = parent === graph.trunk ? (options.targetTrunk ?? graph.trunk) : parent;
    plan.push({
      branch,
      base,
      localHead,
      lastSubmittedVersion: metadata?.lastSubmittedVersion ?? null,
      codeUnchanged: Boolean(
        openPullRequest &&
        metadata?.lastSubmittedVersion === localHead &&
        metadata.lastSubmittedBaseBranch === base,
      ),
      title: firstBranchCommitSubject(git, parent, branch),
      body: openPullRequest ? withoutLegacyStackDescription(openPullRequest.body) : '',
      ...(openPullRequest ? { openPullRequest } : {}),
    });
  }

  for (const item of plan) await editPlanItem(context, item, options);

  if (options.dryRun) {
    renderSubmitPlan(output, plan, 'Would submit');
    return;
  }

  const submissionComment = await resolveComment(context, options.comment);

  if (options.confirm) {
    context.requireInteractive();
    renderSubmitPlan(output, plan, 'Ready to submit');
    const approved = await confirm({ message: `Submit ${plan.length} branch(es)?`, default: true });
    if (!approved) throw ggError('Submit cancelled.');
  }

  if (plan.length > 0) {
    output.line();
    output.line(chalk.bold(`Submitting ${plan.length} ${pluralize('branch', plan.length)}`));
  }

  const urls: string[] = [];
  const pullRequestsByBranch = new Map<string, PullRequest>();
  for (const pullRequest of pullRequestInventory) {
    if (
      pullRequest.state === 'OPEN' &&
      graph.get(pullRequest.headRef) &&
      (!pullRequest.headOwner || pullRequest.headOwner === repository.headOwner)
    ) {
      const existing = pullRequestsByBranch.get(pullRequest.headRef);
      if (existing) {
        throw ggError(
          `Multiple open pull requests exist for ${pullRequest.headRef}:\n${existing.number}: ${existing.url}\n${pullRequest.number}: ${pullRequest.url}`,
        );
      }
      pullRequestsByBranch.set(pullRequest.headRef, pullRequest);
    }
  }
  let pushedAnyBranch = false;
  let stackCommentsRefreshed = false;
  let submissionError: unknown;
  try {
    pushedAnyBranch = pushBranches(context, repository, plan, options);
    for (const [index, item] of plan.entries()) {
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
      pullRequestsByBranch.set(item.branch, pullRequest);
      urls.push(pullRequest.url);
      renderSubmittedItem(output, item, pullRequest, index, plan.length);
    }
  } catch (error) {
    submissionError = error;
  }

  if (!submissionError || pushedAnyBranch) {
    try {
      await git.withRefSnapshotAsync(() =>
        refreshStackComments(client, repository, graph, pullRequestsByBranch),
      );
      stackCommentsRefreshed = true;
    } catch (error) {
      if (!submissionError) throw error;
      output.warning('Could not refresh stack comments after the partial submission.');
    }
  }
  if (stackCommentsRefreshed) {
    for (const item of plan) {
      if (!pullRequestsByBranch.has(item.branch)) continue;
      const row = store.get(item.branch);
      if (!row) continue;
      row.lastSubmittedVersion = item.localHead;
      row.lastSubmittedBaseBranch = item.base;
      store.put(row);
    }
  }
  if (submissionError) throw submissionError;

  if (urls.length === 0) {
    output.line('No branches required submission.');
  } else {
    output.line();
    output.line(`${chalk.green('✔')} ${chalk.bold('Stack submitted.')}`);
  }
  if (options.view || options.web) {
    output.line('Open the pull request URLs above in your browser.');
  }
}

function renderSubmitPlan(
  output: Output,
  plan: SubmitPlanItem[],
  heading: 'Would submit' | 'Ready to submit',
): void {
  output.line();
  output.line(chalk.bold(`${heading} ${plan.length} ${pluralize('branch', plan.length)}`));
  plan.forEach((item, index) => {
    const connector = index === plan.length - 1 ? '└─' : '├─';
    const action = item.openPullRequest ? `update PR #${item.openPullRequest.number}` : 'create PR';
    output.line(
      `  ${chalk.dim(connector)} ${renderRelation(item.branch, item.base)}  ${chalk.dim(action)}`,
    );
  });
}

function renderSubmittedItem(
  output: Output,
  item: SubmitPlanItem,
  pullRequest: PullRequest,
  index: number,
  total: number,
): void {
  const last = index === total - 1;
  const connector = last ? '└─' : '├─';
  const continuation = last ? '  ' : '│ ';
  const action = !item.openPullRequest
    ? chalk.green('(created)')
    : item.codeUnchanged
      ? chalk.dim('(unchanged)')
      : chalk.yellow('(updated)');
  output.line(
    `  ${chalk.dim(connector)} ${chalk.green('✔')} ${chalk.bold(`PR #${pullRequest.number}`)}  ${renderRelation(item.branch, item.base)}  ${action}`,
  );
  output.line(`  ${chalk.dim(continuation)}   ${chalk.blue.underline(pullRequest.url)}`);
}

function canSkipUnchangedSubmit(
  git: Git,
  graph: StackGraph,
  branches: string[],
  options: SubmitOptions,
): boolean {
  if (
    options.dryRun ||
    options.restack ||
    options.publish ||
    options.edit === true ||
    options.editTitle === true ||
    options.editDescription === true ||
    options.reviewers ||
    options.teamReviewers ||
    options.force ||
    options.always ||
    options.mergeWhenReady ||
    options.rerequestReview ||
    options.view ||
    options.comment ||
    options.cli ||
    options.web ||
    options.targetTrunk
  ) {
    return false;
  }
  const heads = git.localBranchHeads();
  return branches.every((branch) => {
    const row = graph.get(branch);
    const head = heads.get(branch);
    const parent = row?.parentBranchName;
    return Boolean(
      row?.lastSubmittedVersion &&
      row.lastSubmittedBaseBranch === parent &&
      row.validationResult === 'VALID' &&
      head === row.lastSubmittedVersion &&
      parent &&
      row.parentBranchRevision &&
      heads.get(parent) === row.parentBranchRevision,
    );
  });
}

async function refreshStackComments(
  client: GitHubClient,
  repository: GitHubRepository,
  graph: StackGraph,
  knownPullRequests: Map<string, PullRequest>,
): Promise<void> {
  const openPullRequests = new Map(knownPullRequests);
  const comments = await client.listComments(repository, [...openPullRequests.values()]);
  const managedComments = new Map(
    comments
      .filter((comment) => comment.body.startsWith(STACK_COMMENT_MARKER))
      .map((comment) => [comment.pullRequestNumber, comment]),
  );
  for (const root of graph.children(graph.trunk)) {
    const stack = graph
      .descendants(root, true)
      .map((branch) => ({ branch, pullRequest: openPullRequests.get(branch) }))
      .filter(
        (item): item is { branch: string; pullRequest: PullRequest } =>
          item.pullRequest !== undefined,
      );
    if (stack.length === 0) continue;

    for (const current of stack) {
      const body = formatStackComment(graph.trunk, stack, current.branch);
      const managed = managedComments.get(current.pullRequest.number);
      if (managed) {
        if (managed.body !== body) await client.updateComment(repository, managed, body);
      } else {
        await client.comment(repository, current.pullRequest, body);
      }
    }
  }
}

function formatStackComment(
  trunk: string,
  stack: Array<{ branch: string; pullRequest: PullRequest }>,
  currentBranch: string,
): string {
  const rows = [
    ...stack.toReversed().map(({ branch, pullRequest }) => {
      const title = escapeMarkdownLinkText(pullRequest.title.replace(/\s+/g, ' ').trim());
      const link = `[#${pullRequest.number} ${title}](${pullRequest.url})`;
      return `- ${branch === currentBranch ? `**${link}** 👈 (This PR)` : link}`;
    }),
    `- ${trunk}`,
  ];
  return `${STACK_COMMENT_MARKER}\n### This pull request is part of a stack:\n\n${rows.join('\n')}\n\n<sub>This stack was generated using [gg](https://github.com/sam-hu/gg)</sub>`;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function withoutLegacyStackDescription(body: string): string {
  return body.replace(/^Stacked branch: `[^`\r\n]+`\r?\n\r?\nBase: `[^`\r\n]+`(?:\r?\n\r?\n)?/, '');
}

function firstBranchCommitSubject(git: Git, parent: string, branch: string): string {
  const subjects = git.capture([
    'log',
    '--reverse',
    '--topo-order',
    '--format=%s',
    `${parent}..${branch}`,
    '--',
  ]);
  return subjects.split('\n')[0] || git.capture(['show', '-s', '--format=%s', branch]);
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

function pushBranches(
  context: RepositoryContext,
  repository: GitHubRepository,
  plan: SubmitPlanItem[],
  options: SubmitOptions,
): boolean {
  const { git } = context;
  if (plan.length === 0) return false;
  const remoteRefs = plan.map((item) => `refs/heads/${item.branch}`);
  const result = git.run(['ls-remote', '--heads', repository.pushUrl, ...remoteRefs], {
    allowFailure: true,
  });
  if (result.status !== 0) throw ggError('Could not inspect remote branches.');
  const remoteHeads = new Map<string, string>();
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [revision, ref] = line.split(/\s+/);
    if (revision && ref) remoteHeads.set(ref, revision);
  }
  const refspecs: string[] = [];
  const leases: string[] = [];
  for (const item of plan) {
    const remoteRef = `refs/heads/${item.branch}`;
    const remoteHead = remoteHeads.get(remoteRef);
    if (remoteHead === item.localHead && !options.always) continue;
    refspecs.push(`refs/heads/${item.branch}:${remoteRef}`);
    if (remoteHead && !git.isAncestor(remoteHead, item.localHead)) {
      if (!item.lastSubmittedVersion || remoteHead !== item.lastSubmittedVersion) {
        if (!options.force) {
          throw ggError(
            `Remote branch ${item.branch} changed after the last successful gg submit. Refusing to overwrite ${remoteHead}. Fetch and reconcile the remote branch before submitting again, or rerun with --force to overwrite this exact remote version.`,
          );
        }
        leases.push(`--force-with-lease=${remoteRef}:${remoteHead}`);
        continue;
      }
      leases.push(`--force-with-lease=${remoteRef}:${item.lastSubmittedVersion}`);
    }
  }
  if (refspecs.length === 0) return false;
  git.run(['push', '--atomic', ...leases, repository.remote, ...refspecs]);
  return true;
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
      draft: !options.publish,
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
