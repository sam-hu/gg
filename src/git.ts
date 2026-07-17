import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { UserError, ggError } from './errors.js';

export class GitCommandError extends UserError {
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;

  constructor(args: string[], stdout: string, stderr: string, status: number) {
    const details = `${stdout}${stderr}`.trimEnd();
    super(
      `ERROR: Command failed with error exit code ${status}:\ngit ${args.join(' ')}${details ? `\n${details}` : ''}`,
      { raw: true },
    );
    this.name = 'GitCommandError';
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
    this.status = status;
  }
}

export interface GitRunOptions {
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stdin?: 'inherit' | 'ignore';
  stdout?: 'inherit' | 'pipe';
  stderr?: 'inherit' | 'pipe';
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class Git {
  readonly root: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  private readonly debug: boolean;

  private constructor(root: string, gitDir: string, commonGitDir: string, debug: boolean) {
    this.root = root;
    this.gitDir = gitDir;
    this.commonGitDir = commonGitDir;
    this.debug = debug;
  }

  static discover(cwd: string, debug = false): Git {
    const rootResult = runProcess(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (rootResult.status !== 0) {
      throw ggError('You must run this command from within a git repository.');
    }
    const root = rootResult.stdout.trim();
    const gitDir = runProcess(root, ['rev-parse', '--absolute-git-dir']).stdout.trim();
    const commonValue = runProcess(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).stdout.trim();
    return new Git(path.resolve(root), path.resolve(gitDir), path.resolve(commonValue), debug);
  }

  run(args: string[], options: GitRunOptions = {}): GitResult {
    if (this.debug) {
      process.stderr.write(`[debug] git ${args.map(redactArgument).join(' ')}\n`);
    }
    return runProcess(this.root, args, options);
  }

  capture(args: string[], options: Omit<GitRunOptions, 'stdout' | 'stderr'> = {}): string {
    return this.run(args, options).stdout.trim();
  }

  succeeds(args: string[]): boolean {
    return this.run(args, { allowFailure: true }).status === 0;
  }

  branch(): string {
    const result = this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw ggError('Cannot perform this operation without a branch checked out.');
    }
    return result.stdout.trim();
  }

  tryBranch(): string | undefined {
    const result = this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  branchExists(branch: string): boolean {
    return this.succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  }

  branches(): string[] {
    const output = this.capture(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  head(revision = 'HEAD'): string {
    return this.capture(['rev-parse', '--verify', `${revision}^{commit}`]);
  }

  tryHead(revision: string): string | undefined {
    const result = this.run(['rev-parse', '--verify', `${revision}^{commit}`], {
      allowFailure: true,
    });
    return result.status === 0 ? result.stdout.trim() : undefined;
  }

  mergeBase(left: string, right: string): string {
    return this.capture(['merge-base', left, right]);
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.succeeds(['merge-base', '--is-ancestor', ancestor, descendant]);
  }

  hasStagedChanges(): boolean {
    return this.run(['diff', '--cached', '--quiet'], { allowFailure: true }).status !== 0;
  }

  hasTrackedChanges(): boolean {
    return this.run(['diff', '--quiet'], { allowFailure: true }).status !== 0;
  }

  hasAnyChanges(): boolean {
    return this.capture(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0;
  }

  hasRebase(): boolean {
    return (
      existsSync(path.join(this.gitDir, 'rebase-merge')) ||
      existsSync(path.join(this.gitDir, 'rebase-apply'))
    );
  }

  switch(branch: string): void {
    this.run(['switch', '-q', branch]);
  }

  updateRef(branch: string, next: string, previous?: string): void {
    const args = ['update-ref', `refs/heads/${branch}`, next];
    if (previous) args.push(previous);
    this.run(args);
  }

  deleteRef(branch: string, expected: string): void {
    this.run(['update-ref', '-d', `refs/heads/${branch}`, expected]);
  }

  isBranchCheckedOutElsewhere(branch: string): boolean {
    const output = this.capture(['worktree', 'list', '--porcelain']);
    let worktree: string | undefined;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) worktree = path.resolve(line.slice('worktree '.length));
      if (
        line === `branch refs/heads/${branch}` &&
        worktree &&
        path.resolve(worktree) !== path.resolve(this.root)
      ) {
        return true;
      }
      if (!line) worktree = undefined;
    }
    return false;
  }
}

function redactArgument(value: string): string {
  if (!value.includes('://') || !value.includes('@')) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = 'REDACTED';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return '[REDACTED_URL]';
  }
}

function runProcess(cwd: string, args: string[], options: GitRunOptions = {}): GitResult {
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    stdio: [options.stdin ?? 'pipe', options.stdout ?? 'pipe', options.stderr ?? 'pipe'],
  };
  const result = spawnSync('git', args, spawnOptions);
  if (result.error) {
    throw new UserError(result.error.message);
  }
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (status !== 0 && !options.allowFailure) {
    throw new GitCommandError(args, stdout, stderr, status);
  }
  return { status, stdout, stderr };
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    input?: string;
  },
): GitResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
  });
  if (result.error) throw new UserError(result.error.message);
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (status !== 0 && !options.allowFailure) {
    throw new UserError(`${command} ${args.join(' ')} failed:\n${stdout}${stderr}`.trimEnd());
  }
  return { status, stdout, stderr };
}
