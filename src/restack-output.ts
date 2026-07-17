import chalk from 'chalk';
import type { Output } from './output.js';

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
  lines.forEach((line, index) => {
    const connector = index === lines.length - 1 ? '└─' : '├─';
    output.line(`  ${chalk.dim(connector)} ${line}`);
  });
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}es`;
}
