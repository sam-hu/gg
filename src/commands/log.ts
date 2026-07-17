import { existsSync, readFileSync } from 'node:fs';
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
  let graph = new StackGraph(context.git, context.store);
  const validation = graph.refresh();
  graph = new StackGraph(context.git, context.store);
  const current = currentBranchForLog(context);
  if (style === 'long') {
    renderLong(context);
  } else if (options.classic) {
    renderClassic(context, graph);
  } else {
    const visible = visibleBranches(graph, current, options);
    const ordered = options.reverse ? visible : visible.toReversed();
    for (const branch of ordered) {
      if (style === 'short') renderShort(context, graph, branch, current);
      else renderDefault(context, graph, branch, current);
    }
  }

  if (validation.diverged.length > 0) {
    context.output.line("WARNING: The following branch has diverged from gg's tracking:");
    for (const branch of validation.diverged) context.output.line(`  ${branch}`);
  }
  if (validation.missing.length > 0) {
    context.output.line('WARNING: The following tracked branches no longer exist locally:');
    for (const branch of validation.missing) context.output.line(`  ${branch}`);
  }

  if (style !== 'long' && !options.classic && options.showUntracked) {
    const tracked = new Set(graph.trackedBranches());
    const untracked = context.git
      .branches()
      .filter((branch) => !tracked.has(branch))
      .toSorted();
    if (untracked.length > 0) {
      context.output.line('Untracked branches:');
      for (const branch of untracked) context.output.line(`  ${branch}`);
    }
  }
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
): void {
  const marker = branch === current ? '◉' : '◯';
  const indent = '  '.repeat(graph.depth(branch));
  context.output.line(
    `${indent}${marker}  ${branch}${branch === current ? ' (current)' : ''}${statusSuffix(context, graph, branch)}`,
  );
}

function renderDefault(
  context: RepositoryContext,
  graph: StackGraph,
  branch: string,
  current: string | undefined,
): void {
  const marker = branch === current ? '◉' : '◯';
  const indent = '  '.repeat(graph.depth(branch));
  const revision = context.git.tryHead(branch);
  context.output.line(
    `${indent}${marker} ${branch}${branch === current ? ' (current)' : ''}${statusSuffix(context, graph, branch)}`,
  );
  if (!revision) return;
  const age = context.git.capture(['show', '-s', '--format=%cr', branch]);
  const subject = context.git.capture(['show', '-s', '--format=%s', branch]);
  context.output.line(`${indent}│ ${age}`);
  context.output.line(`${indent}│ `);
  context.output.line(`${indent}│ ${revision.slice(0, 7)} - ${subject}`);
  context.output.line(`${indent}│`);
}

function renderLong(context: RepositoryContext): void {
  const commits = context.git.capture([
    'log',
    '--graph',
    '--oneline',
    '--decorate',
    '--date-order',
    '--branches',
  ]);
  if (commits) for (const line of commits.split('\n')) context.output.line(line);
}

function renderClassic(context: RepositoryContext, graph: StackGraph): void {
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
    context.output.line(`${'  '.repeat(graph.depth(branch))}↱ $ ${branch}`);
  }
}

function statusSuffix(context: RepositoryContext, graph: StackGraph, branch: string): string {
  const statuses: string[] = [];
  if (graph.needsRestack(branch)) statuses.push('needs restack');
  const submitted = graph.get(branch)?.lastSubmittedVersion;
  if (submitted) {
    statuses.push(submitted === context.git.tryHead(branch) ? 'submitted' : 'changed since submit');
  }
  return statuses.length > 0 ? ` (${statuses.join(', ')})` : '';
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
