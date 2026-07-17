import { checkbox, select } from '@inquirer/prompts';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import type { RepositoryContext } from '../context.js';
import { RestackEngine } from '../restack.js';

export interface BranchCreateOptions {
  message?: string[];
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  insert?: boolean;
  onto?: string;
  verbose?: number;
}

export async function createBranch(
  context: RepositoryContext,
  suppliedName: string | undefined,
  options: BranchCreateOptions,
): Promise<void> {
  await context.ensureInitialized();
  const { git, store, output } = context;
  const engine = new RestackEngine(git, store, output, context.verify);
  engine.ensureNotBlocked();
  const graph = new StackGraph(git, store);
  const originalBranch = git.branch();
  const parent = options.onto ?? originalBranch;
  graph.require(parent);
  if (!git.branchExists(parent)) throw ggError(`Could not find branch ${parent}.`);

  await stageForCreate(context, options);
  const messages = options.message ?? [];
  const name = suppliedName ?? generatedBranchName(messages[0]);
  if (!name) {
    throw ggError('Must specify either a branch name or commit message.');
  }
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

  try {
    git.run(['switch', '-q', '-c', name, parent]);
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
    } else {
      output.line('No staged changes; creating a branch with no commit.');
    }
  } catch (error) {
    if (git.tryBranch() === name) git.switch(parent);
    if (git.branchExists(name)) git.run(['branch', '-D', name], { allowFailure: true });
    throw error;
  }

  const branchHead = git.head(name);
  store.track(name, parent, parentHead, branchHead);

  if (options.insert && childrenToInsert.length > 0) {
    for (const child of childrenToInsert) {
      await engine.move(child, name, false, `branch create ${name} --insert`);
    }
  }
}

async function stageForCreate(
  context: RepositoryContext,
  options: BranchCreateOptions,
): Promise<void> {
  const { git } = context;
  if (options.all) git.run(['add', '-A']);
  else if (options.update) git.run(['add', '-u']);
  else if (options.patch)
    git.run(['add', '--patch'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });

  if (
    git.hasStagedChanges() ||
    !git.hasAnyChanges() ||
    options.all ||
    options.update ||
    options.patch
  ) {
    return;
  }
  if (!context.interactive) return;
  const action = await select({
    message: 'You have no staged changes. What would you like to do?',
    choices: [
      { name: 'Commit all file changes (--all)', value: 'all' },
      { name: 'Commit all changes to tracked files (--update)', value: 'update' },
      { name: 'Select changes to commit (--patch)', value: 'patch' },
      { name: 'Create a branch with no commit', value: 'empty' },
      { name: 'Abort this operation', value: 'abort' },
    ],
  });
  if (action === 'all') git.run(['add', '-A']);
  else if (action === 'update') git.run(['add', '-u']);
  else if (action === 'patch') {
    git.run(['add', '--patch'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
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
