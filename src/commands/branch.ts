import { checkbox, select } from '@inquirer/prompts';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import type { RepositoryContext } from '../context.js';
import { buildMoveTreeChoices } from '../move-tree.js';
import { selectWithEscape } from '../prompts.js';
import { RestackEngine } from '../restack.js';
import { stageChanges, stageRequestedChanges, STAGING_CHOICES } from '../staging.js';

export interface BranchCreateOptions {
  message?: string[];
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  insert?: boolean;
  onto?: string;
  verbose?: number;
}

export interface TrackOptions {
  parent?: string;
}

export async function trackBranch(
  context: RepositoryContext,
  suppliedBranch: string | undefined,
  options: TrackOptions,
): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  await new RestackEngine(git, store, output, context.verify).ensureNotBlocked();
  const graph = new StackGraph(git, store);
  const branch = suppliedBranch ?? git.branch();

  if (!git.branchExists(branch)) throw ggError(`Could not find branch ${branch}.`);
  if (branch === graph.trunk)
    throw ggError('Cannot track the trunk branch beneath another branch.');

  let parent = options.parent;
  if (!parent) {
    context.requireInteractive();
    const excluded = new Set([branch, ...graph.descendants(branch)]);
    const candidates = graph
      .trackedBranches()
      .filter((candidate) => !excluded.has(candidate) && git.branchExists(candidate));
    parent = await selectWithEscape({
      message: `Choose a parent for ${branch} (arrow keys, Enter, or Esc to cancel)`,
      choices: buildMoveTreeChoices(graph, candidates),
      default: graph.parent(branch) ?? graph.trunk,
      pageSize: 12,
    });
    if (!parent) {
      output.line('Tracking cancelled.');
      return;
    }
  }

  if (!git.branchExists(parent)) throw ggError(`Could not find branch ${parent}.`);
  graph.require(parent);
  if (parent === branch) throw ggError('A branch cannot be its own parent.');
  if (graph.get(branch) && graph.isDescendant(parent, branch)) {
    throw ggError(`Cannot track ${branch} onto ${parent} because it is a child of ${branch}.`);
  }

  const mergeBase = git.run(['merge-base', parent, branch], { allowFailure: true });
  const parentRevision = mergeBase.stdout.trim();
  if (mergeBase.status !== 0 || !parentRevision) {
    throw ggError(`Branches ${branch} and ${parent} do not share any history.`);
  }

  store.track(branch, parent, parentRevision, git.head(branch));
  output.line(`Tracked ${branch} with parent ${parent}.`);
}

export async function createBranch(
  context: RepositoryContext,
  suppliedName: string | undefined,
  options: BranchCreateOptions,
): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  await engine.ensureNotBlocked();
  const graph = new StackGraph(git, store);
  const originalBranch = git.branch();
  const parent = options.onto ?? originalBranch;
  graph.require(parent);
  if (!git.branchExists(parent)) throw ggError(`Could not find branch ${parent}.`);

  const messages = options.message ?? [];
  const name = suppliedName ?? generatedBranchName(messages[0]);
  if (!name) {
    throw ggError('Must specify either a branch name or commit message.');
  }
  if (!git.isValidBranchName(name)) throw ggError(`Invalid branch name: ${name}`);
  if (git.branchExists(name)) throw ggError('Branch with this name already exists');
  const previousChildren = graph.children(parent);
  let childrenToInsert = options.insert ? previousChildren : [];
  if (options.insert && context.interactive && previousChildren.length > 0) {
    childrenToInsert = await checkbox({
      message: `Which branches would you like to move onto ${name}?`,
      choices: previousChildren.map((child) => ({ name: child, value: child, checked: true })),
    });
  }
  const parentHead = git.head(parent);

  if (options.insert && childrenToInsert.length > 0) {
    const worktree = git.captureWorktreeSnapshot();
    await engine.createAndInsertBranch(
      name,
      parent,
      childrenToInsert,
      worktree,
      async (checkpoint) => {
        await stageForCreate(context, options);
        createTrackedBranch(context, name, parent, parentHead, messages, options, checkpoint);
      },
    );
    return;
  }

  await stageForCreate(context, options);
  createTrackedBranch(context, name, parent, parentHead, messages, options);
}

function createTrackedBranch(
  context: RepositoryContext,
  name: string,
  parent: string,
  parentHead: string,
  messages: string[],
  options: BranchCreateOptions,
  checkpoint?: () => void,
): void {
  const { git, store, output } = context;
  try {
    git.run(['switch', '-q', '-c', name, parent]);
    checkpoint?.();
    if (git.hasStagedChanges()) {
      const args = ['commit', '-q'];
      if (!context.verify) args.push('--no-verify');
      for (let index = 0; index < (options.verbose ?? 0); index += 1) args.push('-v');
      for (const message of messages) args.push('-m', message);
      git.run(args, {
        stdin: messages.length === 0 ? 'inherit' : 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      checkpoint?.();
    } else {
      output.line('No staged changes; creating a branch with no commit.');
    }
  } catch (error) {
    if (!checkpoint) {
      if (git.tryBranch() === name) git.switch(parent);
      if (git.branchExists(name)) git.run(['branch', '-D', name], { allowFailure: true });
    }
    throw error;
  }

  const branchHead = git.head(name);
  store.track(name, parent, parentHead, branchHead);
  checkpoint?.();
}

async function stageForCreate(
  context: RepositoryContext,
  options: BranchCreateOptions,
): Promise<void> {
  const { git } = context;
  const explicitlyStaged = stageRequestedChanges(git, options);

  if (git.hasStagedChanges() || !git.hasAnyChanges() || explicitlyStaged) {
    return;
  }
  if (!context.interactive) return;
  const action = await select({
    message: 'You have no staged changes. What would you like to do?',
    choices: [
      ...STAGING_CHOICES,
      { name: 'Create a branch with no commit', value: 'empty' },
      { name: 'Abort this operation', value: 'abort' },
    ],
  });
  if (action === 'all' || action === 'update' || action === 'patch') {
    stageChanges(git, action);
  } else if (action === 'abort') {
    throw ggError('Aborted branch creation.');
  }
}

function generatedBranchName(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const suffix = message.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${month}-${day}-${suffix}`;
}
