import { select } from '@inquirer/prompts';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import { RestackEngine } from '../restack.js';

export interface CommitOptions {
  message?: string[];
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  edit?: boolean;
  resetAuthor?: boolean;
  interactiveRebase?: boolean;
  into?: string;
}

export async function createCommit(
  context: RepositoryContext,
  options: CommitOptions,
): Promise<void> {
  await commitOrAmend(context, 'create', options);
}

export async function amendCommit(
  context: RepositoryContext,
  options: CommitOptions,
): Promise<void> {
  await commitOrAmend(context, 'amend', options);
}

async function commitOrAmend(
  context: RepositoryContext,
  mode: 'create' | 'amend',
  options: CommitOptions,
): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  engine.ensureNotBlocked();
  const graph = new StackGraph(git, store);
  const branch = git.branch();
  const branchMetadata = graph.require(branch);
  if (branch === graph.trunk) {
    throw ggError(`Cannot perform this operation on the trunk branch.\n\n${graph.trunk}`);
  }
  if (options.into) {
    throw ggError('--into is not supported by this GitHub-native implementation.');
  }
  if (options.interactiveRebase) {
    throw ggError('--interactive-rebase is not supported by this implementation.');
  }
  if (
    mode === 'amend' &&
    branchMetadata.parentBranchRevision &&
    git.head(branch) === branchMetadata.parentBranchRevision
  ) {
    throw ggError('No changes to commit.');
  }

  await stageForCommit(context, mode, options);
  if (mode === 'create' && !git.hasStagedChanges()) {
    throw ggError('No changes to commit.');
  }

  const args = ['commit'];
  if (mode === 'amend') args.push('--amend');
  if (!context.verify) args.push('--no-verify');
  if (options.resetAuthor) args.push('--reset-author');
  const messages = options.message ?? [];
  for (const message of messages) args.push('-m', message);
  if (mode === 'amend' && messages.length === 0 && !options.edit) args.push('--no-edit');
  if (options.edit) args.push('--edit');
  git.run(args, {
    stdin: messages.length === 0 && (mode === 'create' || options.edit) ? 'inherit' : 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  store.updateBranchRevision(branch, git.head(branch));
  await engine.restackDescendantsWithoutHalting(
    branch,
    'Please resolve conflicts in the current stack with gg restack.',
  );
}

async function stageForCommit(
  context: RepositoryContext,
  mode: 'create' | 'amend',
  options: CommitOptions,
): Promise<void> {
  const { git } = context;
  if (options.all) git.run(['add', '-A']);
  else if (options.update) git.run(['add', '-u']);
  else if (options.patch) {
    git.run(['add', '--patch'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  }
  if (git.hasStagedChanges() || !git.hasAnyChanges() || !context.interactive) return;
  const choices = [
    { name: 'Commit all file changes (--all)', value: 'all' },
    { name: 'Commit all changes to tracked files (--update)', value: 'update' },
    { name: 'Select changes to commit (--patch)', value: 'patch' },
    mode === 'amend'
      ? { name: 'Just edit the commit message', value: 'message' }
      : { name: 'Abort this operation', value: 'abort' },
    ...(mode === 'amend' ? [{ name: 'Abort this operation', value: 'abort' }] : []),
  ];
  const action = await select({
    message: 'You have no staged changes. What would you like to do?',
    choices,
  });
  if (action === 'all') git.run(['add', '-A']);
  else if (action === 'update') git.run(['add', '-u']);
  else if (action === 'patch') {
    git.run(['add', '--patch'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  } else if (action === 'abort') {
    throw ggError('Aborted commit operation.');
  }
}
