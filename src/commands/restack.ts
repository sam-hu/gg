import { confirm } from '@inquirer/prompts';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import { buildMoveTreeChoices } from '../move-tree.js';
import { selectWithEscape } from '../prompts.js';
import { RestackEngine } from '../restack.js';

export interface RestackOptions {
  branch?: string;
  downstack?: boolean;
  upstack?: boolean;
  only?: boolean;
}

export async function restackBranches(
  context: RepositoryContext,
  options: RestackOptions,
): Promise<void> {
  await context.ensureInitialized();
  const branch = options.branch ?? context.git.branch();
  const scope = options.only
    ? 'only'
    : options.downstack
      ? 'downstack'
      : options.upstack
        ? 'upstack'
        : 'stack';
  await new RestackEngine(context.git, context.store, context.output, context.verify).restack(
    branch,
    scope,
    commandText('restack', options),
  );
}

export interface MoveOptions {
  onto?: string;
  source?: string;
  only?: boolean;
  all?: boolean;
}

export async function moveBranches(
  context: RepositoryContext,
  options: MoveOptions,
): Promise<void> {
  await context.ensureInitialized();
  const graph = new StackGraph(context.git, context.store);
  const source = options.source ?? context.git.branch();
  graph.require(source);
  if (source === graph.trunk) throw ggError('Cannot perform this operation on the trunk branch.');
  let target = options.onto;
  if (!target) {
    context.requireInteractive();
    const excluded = new Set([source, ...graph.descendants(source)]);
    const candidates = graph
      .trackedBranches()
      .filter((branch) => !excluded.has(branch) && context.git.branchExists(branch));
    target = await selectWithEscape({
      message: `Choose a new base for ${source} (type to search, arrow keys, or Esc to cancel)`,
      choices: buildMoveTreeChoices(graph, candidates),
      default: graph.parent(source),
      pageSize: 12,
    });
    if (!target) {
      context.output.line('Move cancelled.');
      return;
    }
  }
  if (!context.git.branchExists(target)) throw ggError(`Could not find branch ${target}.`);
  await new RestackEngine(context.git, context.store, context.output, context.verify).move(
    source,
    target,
    options.only ?? false,
    commandText('move', options),
  );
}

export async function continueOperation(context: RepositoryContext, all: boolean): Promise<void> {
  await context.ensureInitialized();
  await new RestackEngine(context.git, context.store, context.output, context.verify).continue(all);
}

export async function abortOperation(context: RepositoryContext, force: boolean): Promise<void> {
  await context.ensureInitialized();
  if (!force) {
    context.requireInteractive();
    const approved = await confirm({
      message: 'Are you sure you want to abort the current gg operation?',
      default: false,
    });
    if (!approved) {
      context.output.line('🛑 Aborted abort.');
      return;
    }
  }
  const command = new RestackEngine(
    context.git,
    context.store,
    context.output,
    context.verify,
  ).abort();
  context.output.line(`Successfully aborted gg ${command}.`);
}

function commandText(command: string, options: object): string {
  const args = [command];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    args.push(flag);
    if (value !== true) args.push(String(value));
  }
  return args.join(' ');
}
