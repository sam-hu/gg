import path from 'node:path';
import { existsSync } from 'node:fs';
import { confirm, select } from '@inquirer/prompts';
import { ggError } from './errors.js';
import { Git } from './git.js';
import { MetadataStore } from './metadata.js';
import { Output } from './output.js';

export interface GlobalOptions {
  cwd?: string;
  debug?: boolean;
  interactive?: boolean;
  verify?: boolean;
  quiet?: boolean;
}

export class RepositoryContext {
  readonly git: Git;
  readonly output: Output;
  readonly interactive: boolean;
  readonly verify: boolean;
  private storeValue?: MetadataStore;

  private constructor(git: Git, output: Output, interactive: boolean, verify: boolean) {
    this.git = git;
    this.output = output;
    this.interactive = interactive;
    this.verify = verify;
  }

  static discover(options: GlobalOptions): RepositoryContext {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const interactive =
      !options.quiet &&
      (options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
    return new RepositoryContext(
      Git.discover(cwd, options.debug ?? false),
      new Output({ quiet: options.quiet ?? false }),
      interactive,
      options.verify ?? true,
    );
  }

  get store(): MetadataStore {
    this.storeValue ??= MetadataStore.open(this.git);
    return this.storeValue;
  }

  close(): void {
    this.storeValue?.close();
  }

  async ensureInitialized(): Promise<void> {
    if (MetadataStore.isInitialized(this.git)) return;
    this.output.line('gg has not been initialized, attempting to set it up now...');
    await initializeRepository(this, {});
  }

  requireInteractive(): void {
    if (!this.interactive) {
      throw ggError('Cannot perform interactive operation in non-interactive mode.');
    }
  }
}

export interface InitOptions {
  trunk?: string;
  reset?: boolean;
}

export async function initializeRepository(
  context: RepositoryContext,
  options: InitOptions,
): Promise<void> {
  const { git, output } = context;
  if (git.hasRebase()) {
    throw ggError(
      'This operation is blocked during a rebase.\nResolve it with gg continue or cancel it with gg abort.',
    );
  }
  if (existsSync(path.join(git.commonGitDir, '.gg_operation_state'))) {
    throw ggError(
      'A gg operation was interrupted. Run gg continue to resume it or gg abort to restore its starting state.',
    );
  }
  const branches = git.branches();
  if (branches.length === 0) {
    throw ggError(
      'No branches found in current repo; cannot initialize gg.\nPlease create your first commit and then re-run your gg command.',
    );
  }

  const existing = MetadataStore.isInitialized(git) ? context.store.config() : undefined;
  let candidate = options.trunk;
  if (candidate && !git.branchExists(candidate)) {
    output.warning(`The branch ${candidate} does not exist locally and cannot be made a trunk.`);
    candidate = undefined;
  }
  candidate ??= existing?.trunk && git.branchExists(existing.trunk) ? existing.trunk : undefined;
  candidate ??= inferTrunk(git, branches);

  if (!candidate) {
    if (!context.interactive) {
      throw ggError(
        'Could not infer trunk branch, pass in an existing branch name with --trunk or run in interactive mode.',
      );
    }
    const preferred = branches.toSorted((left, right) => {
      const rank = (name: string): number =>
        ['develop', 'main', 'master'].includes(name)
          ? ['develop', 'main', 'master'].indexOf(name)
          : 3;
      return rank(left) - rank(right) || left.localeCompare(right);
    });
    candidate = await select({
      message: 'Select a trunk branch, which you base branches on (autocomplete or arrow keys)',
      choices: preferred.map((branch) => ({ name: branch, value: branch })),
    });
  }

  if (existing) {
    output.line('Reinitializing gg...');
    if (existing.trunk !== candidate && !options.reset) {
      if (!context.interactive) {
        throw ggError(
          `Changing trunk from ${existing.trunk} to ${candidate} requires interactive confirmation.`,
        );
      }
      const approved = await confirm({
        message: `Change trunk from ${existing.trunk} to ${candidate}?`,
        default: false,
      });
      if (!approved) throw ggError('Trunk branch was not changed.');
    }
  } else {
    output.line('Welcome to gg!');
    output.line();
  }

  const revision = git.head(candidate);
  context.store.initialize(candidate, revision, options.reset ?? false);
  if (options.reset) output.line('All branches have been untracked');
  output.line(`Trunk set to ${candidate}`);
}

function inferTrunk(git: Git, branches: string[]): string | undefined {
  const remoteHead = git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  });
  if (remoteHead.status === 0) {
    const value = remoteHead.stdout.trim().replace(/^origin\//, '');
    if (git.branchExists(value)) return value;
  }
  if (branches.length === 1) return branches[0];
  return undefined;
}
