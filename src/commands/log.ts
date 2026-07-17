import { existsSync, readFileSync } from 'node:fs';
import chalk from 'chalk';
import type { RepositoryContext } from '../context.js';
import { StackGraph } from '../graph.js';
import type { OperationState } from '../restack.js';

export interface LogOptions {
  reverse?: boolean;
  stack?: boolean;
  steps?: string | number;
  showUntracked?: boolean;
  classic?: boolean;
  all?: boolean;
}

export async function showLog(
  context: RepositoryContext,
  style: 'default' | 'short' | 'long',
  options: LogOptions,
): Promise<void> {
  await context.ensureInitialized();
  const lines: string[] = [];
  let graph = new StackGraph(context.git, context.store);
  const validation = graph.refresh();
  graph = new StackGraph(context.git, context.store);
  const current = currentBranchForLog(context);
  if (style === 'long') {
    renderLong(context, lines);
  } else if (options.classic) {
    renderClassic(context, graph, lines);
  } else {
    const visible = visibleBranches(graph, current, options);
    const topologyLayout =
      style === 'default' && !options.reverse && !options.stack && options.steps === undefined;
    if (topologyLayout) {
      renderDefaultGraph(context, graph, current, new Set(visible), lines);
    } else {
      const ordered = options.reverse ? visible : visible.toReversed();
      for (const branch of ordered) {
        if (style === 'short') renderShort(context, graph, branch, current, lines);
        else
          renderDefaultBranch(
            context,
            graph,
            branch,
            current,
            '  '.repeat(graph.depth(branch)),
            lines,
          );
      }
    }
  }

  if (validation.diverged.length > 0) {
    lines.push(chalk.yellow("WARNING: The following branch has diverged from gg's tracking:"));
    for (const branch of validation.diverged) lines.push(chalk.yellow(`  ${branch}`));
  }
  if (validation.missing.length > 0) {
    lines.push(chalk.yellow('WARNING: The following tracked branches no longer exist locally:'));
    for (const branch of validation.missing) lines.push(chalk.yellow(`  ${branch}`));
  }

  if (style !== 'long' && !options.classic && options.showUntracked) {
    const tracked = new Set(graph.trackedBranches());
    const untracked = context.git
      .branches()
      .filter((branch) => !tracked.has(branch))
      .toSorted();
    if (untracked.length > 0) {
      lines.push('Untracked branches:');
      for (const branch of untracked) lines.push(`  ${branch}`);
    }
  }

  context.output.page(lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

function visibleBranches(
  graph: StackGraph,
  current: string | undefined,
  options: LogOptions,
): string[] {
  let branches: string[];
  if ((options.stack || options.steps !== undefined) && current && graph.get(current)) {
    const ancestors = graph.ancestors(current, true).reverse();
    const descendants = graph.descendants(current, false, true);
    branches = [...ancestors, ...descendants];
  } else {
    branches = [graph.trunk, ...graph.descendants(graph.trunk, false, true)];
  }
  if (options.steps !== undefined) {
    const steps = Math.max(0, Number.parseInt(String(options.steps), 10));
    const index = current ? branches.indexOf(current) : -1;
    if (index >= 0) branches = branches.slice(Math.max(0, index - steps), index + steps + 1);
  }
  return branches.filter((branch) => {
    const row = graph.get(branch);
    return (
      row &&
      row.validationResult !== 'BAD_PARENT_REVISION' &&
      row.validationResult !== 'BAD_PARENT_NAME'
    );
  });
}

function renderShort(
  context: RepositoryContext,
  graph: StackGraph,
  branch: string,
  current: string | undefined,
  lines: string[],
): void {
  const indent = '  '.repeat(graph.depth(branch));
  lines.push(
    `${indent}${branchMarker(branch, current)}  ${branchLabel(branch, current)}${statusSuffix(context, graph, branch)}`,
  );
}

function renderDefaultGraph(
  context: RepositoryContext,
  graph: StackGraph,
  current: string | undefined,
  visible: Set<string>,
  lines: string[],
): void {
  const visit = (branch: string, prefix: string): void => {
    const children = graph.children(branch).filter((child) => visible.has(child));
    for (const [index, child] of children.entries()) {
      visit(child, `${prefix}${'│  '.repeat(index)}`);
    }
    if (children.length > 1) {
      lines.push(chalk.gray(`${prefix}├──${'┴──'.repeat(children.length - 2)}┘`));
    }
    if (visible.has(branch)) renderDefaultBranch(context, graph, branch, current, prefix, lines);
  };
  visit(graph.trunk, '');
}

function renderDefaultBranch(
  context: RepositoryContext,
  graph: StackGraph,
  branch: string,
  current: string | undefined,
  prefix: string,
  lines: string[],
): void {
  const revision = context.git.tryHead(branch);
  lines.push(
    `${chalk.gray(prefix)}${branchMarker(branch, current)} ${branchLabel(branch, current)}${statusSuffix(context, graph, branch)}`,
  );
  if (!revision) return;
  const parent = graph.parent(branch);
  if (parent && revision === context.git.tryHead(parent)) {
    lines.push(chalk.gray(`${prefix}│ `));
    lines.push(chalk.gray(`${prefix}│ `));
    lines.push(chalk.gray(`${prefix}│`));
    return;
  }
  const age = context.git.capture(['show', '-s', '--format=%cr', branch]);
  const subject = context.git.capture(['show', '-s', '--format=%s', branch]);
  lines.push(chalk.gray(`${prefix}│ ${age}`));
  lines.push(chalk.gray(`${prefix}│ `));
  lines.push(chalk.gray(`${prefix}│ ${revision.slice(0, 7)} - ${subject}`));
  lines.push(chalk.gray(`${prefix}│`));
}

function renderLong(context: RepositoryContext, lines: string[]): void {
  const commits = context.git.capture([
    'log',
    '--graph',
    '--oneline',
    '--decorate',
    '--date-order',
    '--branches',
  ]);
  if (commits) lines.push(...commits.split('\n'));
}

function renderClassic(context: RepositoryContext, graph: StackGraph, lines: string[]): void {
  const branches = [graph.trunk, ...graph.descendants(graph.trunk, false, true)].toReversed();
  for (const branch of branches) {
    const row = graph.get(branch);
    if (
      !row ||
      row.validationResult === 'BAD_PARENT_NAME' ||
      row.validationResult === 'BAD_PARENT_REVISION'
    ) {
      continue;
    }
    lines.push(`${chalk.gray(`${'  '.repeat(graph.depth(branch))}↱ $`)} ${chalk.blue(branch)}`);
  }
}

function branchMarker(branch: string, current: string | undefined): string {
  return branch === current ? chalk.cyan('◉') : chalk.gray('◯');
}

function branchLabel(branch: string, current: string | undefined): string {
  return branch === current ? chalk.cyan(`${branch} (current)`) : chalk.blue(branch);
}

function statusSuffix(context: RepositoryContext, graph: StackGraph, branch: string): string {
  const statuses: string[] = [];
  if (graph.needsRestack(branch)) statuses.push('needs restack');
  const submitted = graph.get(branch)?.lastSubmittedVersion;
  if (submitted) {
    statuses.push(submitted === context.git.tryHead(branch) ? 'submitted' : 'changed since submit');
  }
  if (statuses.length === 0) return '';
  const suffix = ` (${statuses.join(', ')})`;
  return statuses.every((status) => status === 'submitted')
    ? chalk.green(suffix)
    : chalk.yellow(suffix);
}

function currentBranchForLog(context: RepositoryContext): string | undefined {
  if (existsSync(context.store.operationPath)) {
    try {
      const state = JSON.parse(readFileSync(context.store.operationPath, 'utf8')) as OperationState;
      if (state.ownerGitDir === context.git.gitDir) return state.currentBranchOverride;
    } catch {
      // Fall back to Git's current branch when the sidecar is unreadable.
    }
  }
  return context.git.tryBranch();
}
