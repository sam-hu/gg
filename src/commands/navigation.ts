import { select } from '@inquirer/prompts';
import type { RepositoryContext } from '../context.js';
import { ggError } from '../errors.js';
import { StackGraph } from '../graph.js';
import { buildMoveTreeChoices } from '../move-tree.js';
import { selectWithEscape } from '../prompts.js';

export async function checkoutBranch(context: RepositoryContext, branch?: string): Promise<void> {
  await context.ensureInitialized();
  const graph = new StackGraph(context.git, context.store);
  let target = branch;
  if (!target) {
    context.requireInteractive();
    const candidates = graph
      .trackedBranches()
      .filter((candidate) => context.git.branchExists(candidate));
    target = await selectWithEscape({
      message: 'Checkout a branch (arrow keys, Enter, or Esc to cancel)',
      choices: buildMoveTreeChoices(graph, candidates),
      default: context.git.tryBranch(),
      pageSize: 12,
    });
    if (!target) {
      context.output.line('Checkout cancelled.');
      return;
    }
  }

  if (!context.git.branchExists(target)) throw ggError(`Could not find branch ${target}.`);
  if (graph.get(target)) {
    checkoutWithHint(context, graph, target, false);
    return;
  }
  context.git.switch(target);
  context.output.line(`Checked out ${target}.`);
  context.output.line('This branch is not tracked by gg.');
}

export async function navigateUp(
  context: RepositoryContext,
  stepsValue: string | number | undefined,
  to?: string,
): Promise<void> {
  await context.ensureInitialized();
  const graph = new StackGraph(context.git, context.store);
  const current = context.git.branch();
  graph.require(current);
  const steps = parseSteps(stepsValue);
  let cursor = current;
  const route = to ? graph.path(current, to) : undefined;
  if (to && (!route || route.length < 2)) {
    throw ggError(`Could not find ${to} upstack from ${current}.`);
  }

  let moved = 0;
  for (let index = 0; index < steps; index += 1) {
    const children = graph.children(cursor);
    if (children.length === 0) break;
    let next: string;
    if (route) {
      const candidate = route[index + 1];
      if (!candidate) break;
      next = candidate;
    } else if (children.length === 1) {
      next = children[0]!;
    } else {
      next = await chooseBranch(context, children, false);
    }
    cursor = next;
    moved += 1;
  }
  if (moved === 0) throw ggError('Already at the top of the stack.');
  checkoutWithHint(context, graph, cursor);
}

export async function navigateDown(
  context: RepositoryContext,
  stepsValue: string | number | undefined,
): Promise<void> {
  await context.ensureInitialized();
  const graph = new StackGraph(context.git, context.store);
  const current = context.git.branch();
  graph.require(current);
  const steps = parseSteps(stepsValue);
  let cursor = current;
  const hops: string[] = [];
  for (let index = 0; index < steps; index += 1) {
    const parent = graph.parent(cursor);
    if (!parent) break;
    requireExistingParent(context, cursor, parent);
    cursor = parent;
    hops.push(cursor);
  }
  if (hops.length === 0) throw ggError('Already at the bottom most branch in the stack.');
  context.output.line(current);
  for (const hop of hops) context.output.line(`⮑  ${hop}`);
  checkoutWithHint(context, graph, cursor, false);
}

export async function navigateTop(context: RepositoryContext): Promise<void> {
  await context.ensureInitialized();
  const graph = new StackGraph(context.git, context.store);
  const current = context.git.branch();
  graph.require(current);
  const leaves = graph.leaves(current).filter((branch) => branch !== current);
  if (leaves.length === 0) throw ggError('Already at the top of the stack.');
  const target = leaves.length === 1 ? leaves[0]! : await chooseBranch(context, leaves, true);
  checkoutWithHint(context, graph, target);
}

export async function navigateBottom(context: RepositoryContext): Promise<void> {
  await context.ensureInitialized();
  const graph = new StackGraph(context.git, context.store);
  const current = context.git.branch();
  graph.require(current);
  if (current === graph.trunk) {
    context.output.line('Already at the bottom most branch in the stack.');
    return;
  }
  const ancestors = graph.ancestors(current, true);
  for (let index = 0; index < ancestors.length - 1; index += 1) {
    const branch = ancestors[index]!;
    const parent = graph.parent(branch);
    if (parent) requireExistingParent(context, branch, parent);
  }
  const target = ancestors.find((branch) => graph.parent(branch) === graph.trunk) ?? current;
  if (target === current) {
    context.output.line('Already at the bottom most branch in the stack.');
    return;
  }
  checkoutWithHint(context, graph, target);
}

async function chooseBranch(
  context: RepositoryContext,
  choices: string[],
  leaves: boolean,
): Promise<string> {
  if (!context.interactive) {
    throw ggError(
      `Cannot get upstack branch in non-interactive mode; multiple choices available:\n${choices.join('\n')}`,
    );
  }
  return select({
    message: 'Multiple branches found. Select a branch (autocomplete or arrow keys)',
    choices: choices.map((branch) => ({
      name: leaves ? `${branch} (top)` : branch,
      value: branch,
    })),
  });
}

function checkoutWithHint(
  context: RepositoryContext,
  graph: StackGraph,
  branch: string,
  printName = true,
): void {
  if (printName) context.output.line(branch);
  context.git.switch(branch);
  context.output.line(`Checked out ${branch}.`);
  if (branch !== graph.trunk) {
    const row = graph.get(branch);
    if (graph.needsRestack(branch)) {
      context.output.line(`This branch has fallen behind ${row?.parentBranchName}.`);
      context.output.line('Run gg restack to resolve.');
    } else if (!row?.lastSubmittedVersion) {
      context.output.line('This branch has not yet been submitted.');
      context.output.line('Run gg submit to push your changes.');
    }
  }
}

function requireExistingParent(context: RepositoryContext, branch: string, parent: string): void {
  if (!context.git.branchExists(parent)) {
    throw ggError(
      `Tracked parent branch ${parent} for ${branch} no longer exists locally. Restore the branch or repair the stack metadata before navigating.`,
    );
  }
}

function parseSteps(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw ggError('Steps must be a positive integer.');
  return Math.floor(parsed);
}
