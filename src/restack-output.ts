import chalk from 'chalk';
import type { Output } from './output.js';
import { pluralize } from './text.js';

export interface BranchRelation {
  branch: string;
  parent: string;
}

export interface RestackResultOptions {
  leadingBlank?: boolean;
  showReady?: boolean;
}

export function renderRestackResult(
  output: Output,
  relations: BranchRelation[],
  options: RestackResultOptions = {},
): void {
  const { leadingBlank = false, showReady = true } = options;
  if (relations.length > 0) {
    if (leadingBlank) output.line();
    output.line(
      chalk.bold(`Restacked ${relations.length} ${pluralize('branch', relations.length)}`),
    );
    renderList(
      output,
      relations.map(({ branch, parent }) => renderRelation(branch, parent)),
    );
    output.line();
  }
  if (showReady) output.line(`${chalk.green('✔')} ${chalk.bold('Stack ready.')}`);
}

export function renderRelation(branch: string, parent: string): string {
  return `${chalk.cyan(branch)} ${chalk.dim('→')} ${chalk.cyan(parent)}`;
}

function renderList(output: Output, lines: string[]): void {
  output.lines(
    lines.map((line, index) => {
      const connector = index === lines.length - 1 ? '└─' : '├─';
      return `  ${chalk.dim(connector)} ${line}`;
    }),
  );
}
