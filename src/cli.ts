#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import {
  createBranch,
  trackBranch,
  type BranchCreateOptions,
  type TrackOptions,
} from './commands/branch.js';
import { amendCommit, createCommit, type CommitOptions } from './commands/commit.js';
import { showLog, type LogOptions } from './commands/log.js';
import { mergeBottomBranch } from './commands/merge.js';
import {
  checkoutBranch,
  navigateBottom,
  navigateDown,
  navigateTop,
  navigateUp,
} from './commands/navigation.js';
import {
  abortOperation,
  continueOperation,
  moveBranches,
  restackBranches,
  type MoveOptions,
  type RestackOptions,
} from './commands/restack.js';
import { submit, type SubmitOptions } from './commands/submit.js';
import { sync, type SyncOptions } from './commands/sync.js';
import {
  initializeRepository,
  RepositoryContext,
  type GlobalOptions,
  type InitOptions,
} from './context.js';
import { UserError } from './errors.js';
import { runGitPassthrough } from './git.js';
import { MutationLease } from './mutation-lease.js';
import { MetadataStore } from './metadata.js';

const program = new Command();
program
  .name('gg')
  .description('A local, GitHub-native stacked-branch CLI')
  .version('0.1.0')
  .showHelpAfterError()
  .option('--cwd <path>', 'run as if gg was started in this directory')
  .option('--debug', 'show debugging information')
  .option('--interactive', 'force interactive prompts')
  .option('--no-interactive', 'disable interactive prompts')
  .option('--verify', 'run Git hooks')
  .option('--no-verify', 'skip Git hooks')
  .option('-q, --quiet', 'suppress non-error output');

program
  .command('init')
  .description('initialize stack metadata and select the trunk branch')
  .option('--trunk <branch>', 'branch to use as trunk')
  .option('--reset', 'untrack every branch except trunk')
  .action(async (options: InitOptions) => {
    await withContext(async (context) => initializeRepository(context, options));
  });

const branch = program.command('branch').description('manage tracked branches');
configureBranchCreate(branch.command('create [name]').description('create a tracked child branch'));
configureBranchCreate(program.command('bc [name]').description('alias for branch create'));

program
  .command('track [branch]')
  .description('start tracking an existing branch')
  .option('-p, --parent <branch>', "tracked branch's parent")
  .action(async (branchName: string | undefined, options: TrackOptions) =>
    withContext((context) => trackBranch(context, branchName, options)),
  );

const commit = program.command('commit').description('create or amend commits in a stack');
configureCommitCreate(
  commit.command('create').description('create a commit and restack descendants'),
);
configureCommitCreate(program.command('cc').description('alias for commit create'));
configureCommitAmend(commit.command('amend').description('amend a commit and restack descendants'));
configureCommitAmend(program.command('ca').description('alias for commit amend'));

program
  .command('up [steps]')
  .alias('u')
  .description('move up the current stack')
  .option('-n, --steps <number>', 'number of branches to move', '1')
  .option('--to <branch>', 'choose the route toward this descendant')
  .action(async (positional: string | undefined, options: { steps: string; to?: string }) => {
    await withContext((context) => navigateUp(context, positional ?? options.steps, options.to));
  });

program
  .command('down [steps]')
  .alias('d')
  .description('move down the current stack')
  .option('-n, --steps <number>', 'number of branches to move', '1')
  .action(async (positional: string | undefined, options: { steps: string }) => {
    await withContext((context) => navigateDown(context, positional ?? options.steps));
  });

program
  .command('top')
  .alias('t')
  .description('check out the top branch of the current stack')
  .action(async () => withContext(navigateTop));

program
  .command('bottom')
  .alias('b')
  .description('check out the bottom branch of the current stack')
  .action(async () => withContext(navigateBottom));

program
  .command('checkout [branch]')
  .alias('co')
  .description('check out a branch, selecting interactively when omitted')
  .action(async (branchName: string | undefined) =>
    withContext((context) => checkoutBranch(context, branchName)),
  );

program
  .command('restack')
  .alias('r')
  .description('recursively restack tracked branches')
  .option('--branch <branch>', 'restack a branch without first checking it out')
  .option('-d, --downstack', 'restack the branch and its ancestors')
  .option('-u, --upstack', 'restack the branch and its descendants')
  .option('-o, --only', 'restack only the selected branch')
  .action(async (options: RestackOptions) =>
    withContext((context) => restackBranches(context, options)),
  );

const logCommand = program
  .command('log [style]')
  .alias('l')
  .description('display tracked stacks (style: short or long)');
configureLogOptions(logCommand).action(async (style: string | undefined, options: LogOptions) => {
  const normalized = style === 'short' || style === 'long' ? style : 'default';
  await withReadContext((context) => showLog(context, normalized, options));
});

configureLogOptions(program.command('ls').description('alias for log short')).action(
  async (options: LogOptions) => withReadContext((context) => showLog(context, 'short', options)),
);
configureLogOptions(program.command('ll').description('alias for log long')).action(
  async (options: LogOptions) => withReadContext((context) => showLog(context, 'long', options)),
);

function configureLogOptions(command: Command): Command {
  return command
    .option('--classic', 'use classic rendering')
    .option('-r, --reverse', 'show trunk first')
    .option('-s, --stack', 'show only the current stack')
    .option('-n, --steps <number>', 'show this many steps around the current branch')
    .option('-u, --show-untracked', 'include untracked local branches')
    .option('-a, --all', 'show all configured trunks');
}

program
  .command('sync')
  .description('fetch trunk, clean merged branches, and restack every stack')
  .option('--restack', 'restack after fetching', true)
  .option('--no-restack', 'skip restacking')
  .option('-f, --force', 'replace a diverged local trunk after validation')
  .option('-d, --delete-all', 'delete every merged or closed PR branch')
  .option('-a, --all', 'sync every configured trunk')
  .action(async (options: SyncOptions) => withContext((context) => sync(context, options)));

program
  .command('merge')
  .description('merge the bottom pull request, restack, and submit the remaining branches')
  .action(async () => withContext(mergeBottomBranch));

program
  .command('move')
  .description('move a branch or stack onto a new parent')
  .option('-o, --onto <branch>', 'new parent branch')
  .option('-s, --source <branch>', 'branch to move (defaults to current)')
  .option('-a, --all', 'move all selected branches')
  .option('--only', 'move only the source and reparent its children downstack')
  .action(async (options: MoveOptions) => withContext((context) => moveBranches(context, options)));

configureSubmit(
  program.command('submit').alias('s').description('push branches and create or update GitHub PRs'),
  false,
);
configureSubmit(program.command('ss').description('alias for submit --stack'), true);

program
  .command('continue')
  .alias('cont')
  .description('continue an interrupted restack or move')
  .option('-a, --all', 'stage all changes before continuing')
  .action(async (options: { all?: boolean }) =>
    withContext((context) => continueOperation(context, options.all ?? false)),
  );

program
  .command('abort')
  .description('abort an interrupted gg operation and restore its refs and metadata')
  .option('-f, --force', 'abort without prompting')
  .action(async (options: { force?: boolean }) =>
    withContext((context) => abortOperation(context, options.force ?? false)),
  );

function configureBranchCreate(command: Command): void {
  command
    .option('-m, --message <message>', 'commit message', collect, [])
    .option('-a, --all', 'stage all changes')
    .option('-u, --update', 'stage tracked changes')
    .option('-p, --patch', 'select changes interactively')
    .option('-i, --insert', 'insert the new branch between its parent and selected children')
    .option('-o, --onto <branch>', 'create from this tracked parent')
    .option('-v, --verbose', 'increase Git commit verbosity', increaseVerbosity, 0)
    .action(async (name: string | undefined, options: BranchCreateOptions) =>
      withContext((context) => createBranch(context, name, options)),
    );
}

function configureCommitCreate(command: Command): void {
  configureCommitCommon(command)
    .description('create a commit and restack descendants')
    .action(async (options: CommitOptions) =>
      withContext((context) => createCommit(context, options)),
    );
}

function configureCommitAmend(command: Command): void {
  configureCommitCommon(command)
    .description('amend the current commit and restack descendants')
    .action(async (options: CommitOptions) =>
      withContext((context) => amendCommit(context, options)),
    );
}

function configureCommitCommon(command: Command): Command {
  return command
    .option('-m, --message <message>', 'commit message', collect, [])
    .option('-a, --all', 'stage all changes')
    .option('-u, --update', 'stage tracked changes')
    .option('-p, --patch', 'select changes interactively')
    .option('-e, --edit', 'open the commit editor')
    .option('--into <branch>', 'fold changes into a downstack branch')
    .option('--reset-author', 'reset commit authorship')
    .option('--interactive-rebase', 'edit commits through an interactive rebase');
}

function configureSubmit(command: Command, stackDefault: boolean): void {
  command
    .option('-d, --draft', 'create new pull requests as drafts (default)')
    .option('-p, --publish', 'publish draft pull requests')
    .option('--restack', 'restack before submitting')
    .option('-e, --edit', 'edit pull request fields')
    .option('-n, --no-edit', 'skip pull request field prompts')
    .option('--edit-title', 'edit titles')
    .option('--no-edit-title', 'do not edit titles')
    .option('--edit-description', 'edit descriptions')
    .option('--no-edit-description', 'do not edit descriptions')
    .option('-r, --reviewers <users>', 'comma-separated reviewers')
    .option('-t, --team-reviewers <teams>', 'comma-separated team reviewers')
    .option('--dry-run', 'show the plan without pushing or mutating PRs')
    .option('-c, --confirm', 'show and confirm the complete plan')
    .option('-u, --update-only', 'only update branches with open PRs')
    .option('-f, --force', 'overwrite an unexpected remote branch tip with an exact lease')
    .option('--always', 'push branches even when the remote tip matches')
    .option('--branch <branch>', 'submit from this branch')
    .option('-m, --merge-when-ready', 'enable GitHub auto-merge')
    .option('--rerequest-review', 'request review again')
    .option('-v, --view', 'print instructions to view the PR')
    .option('--comment [comment]', 'comment on submitted PRs')
    .option('--cli', 'edit PR fields in the terminal')
    .option('-w, --web', 'open PRs in the web UI')
    .option('--target-trunk <branch>', 'override the bottom PR base')
    .option('--ignore-out-of-sync-trunk', 'skip remote trunk equality validation')
    .option('-s, --stack', 'include descendants', stackDefault)
    .option('--no-stack', 'exclude descendants')
    .action(async (options: SubmitOptions) => withContext((context) => submit(context, options)));
}

async function withContext<T>(callback: (context: RepositoryContext) => Promise<T>): Promise<T> {
  const context = RepositoryContext.discover(globalOptionsFromArgv());
  const lease = MutationLease.acquire(context.git, primaryCommandName());
  try {
    return await callback(context);
  } finally {
    try {
      context.close();
    } finally {
      lease.release();
    }
  }
}

async function withReadContext<T>(
  callback: (context: RepositoryContext) => Promise<T>,
): Promise<T> {
  const context = RepositoryContext.discover(globalOptionsFromArgv());
  const readOnly = MetadataStore.canOpenReadOnly(context.git);
  const lease = readOnly ? undefined : MutationLease.acquire(context.git, primaryCommandName());
  if (readOnly) context.useReadOnlyStore();
  try {
    return await callback(context);
  } finally {
    try {
      context.close();
    } finally {
      lease?.release();
    }
  }
}

function primaryCommandName(): string {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--cwd') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--cwd=') || applyBooleanGlobalOption({}, argument)) continue;
    if (!argument.startsWith('-')) return argument;
  }
  return 'unknown command';
}

function globalOptionsFromArgv(): GlobalOptions {
  const options: GlobalOptions = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--cwd' && args[index + 1]) options.cwd = args[++index]!;
    else if (argument.startsWith('--cwd=')) options.cwd = argument.slice('--cwd='.length);
    else applyBooleanGlobalOption(options, argument);
  }
  return options;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function increaseVerbosity(_value: string, previous: number): number {
  return previous + 1;
}

interface GitPassthroughInvocation {
  args: string[];
  options: GlobalOptions;
}

function gitPassthroughInvocation(args: string[]): GitPassthroughInvocation | undefined {
  const forwarded: string[] = [];
  const options: GlobalOptions = {};
  let commandName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!commandName) {
      if (argument === '--cwd' && args[index + 1]) {
        options.cwd = args[++index]!;
        continue;
      }
      if (argument.startsWith('--cwd=')) {
        options.cwd = argument.slice('--cwd='.length);
        continue;
      }
      if (applyBooleanGlobalOption(options, argument)) continue;
    }

    forwarded.push(argument);
    if (!commandName && argument !== '--' && !argument.startsWith('-')) commandName = argument;
  }

  if (!commandName || commandName === 'help') return undefined;
  const isGgCommand = program.commands.some(
    (command) => command.name() === commandName || command.aliases().includes(commandName),
  );
  return isGgCommand ? undefined : { args: forwarded, options };
}

function applyBooleanGlobalOption(options: GlobalOptions, argument: string): boolean {
  if (argument === '--debug') options.debug = true;
  else if (argument === '--interactive') options.interactive = true;
  else if (argument === '--no-interactive') options.interactive = false;
  else if (argument === '--verify') options.verify = true;
  else if (argument === '--no-verify') options.verify = false;
  else if (argument === '--quiet' || argument === '-q') options.quiet = true;
  else return false;
  return true;
}

async function main(): Promise<void> {
  const passthrough = gitPassthroughInvocation(process.argv.slice(2));
  if (passthrough) {
    process.exitCode = runGitPassthrough(
      path.resolve(passthrough.options.cwd ?? process.cwd()),
      passthrough.args,
      passthrough.options.debug ?? false,
    );
    return;
  }
  await program.parseAsync(process.argv);
}

try {
  await main();
} catch (error) {
  if (error instanceof UserError) {
    if (error.message)
      process.stderr.write(error.message.endsWith('\n') ? error.message : `${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message} \n`);
    process.exitCode = 1;
  }
}
