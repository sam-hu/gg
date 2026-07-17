import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const configuredRoot = process.env.GG_TEST_TMPDIR;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function command(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string } = { cwd: process.cwd() },
): CommandResult {
  const result: SpawnSyncReturns<string> = spawnSync(executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...options.env,
    },
    input: options.input,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function git(repo: string, ...args: string[]): CommandResult {
  return command('git', ['-C', repo, ...args], { cwd: repo });
}

export function gg(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): CommandResult {
  return command(process.execPath, [cli, ...args, '--cwd', repo, '--no-interactive'], {
    cwd: repo,
    env,
  });
}

export function createTempRoot(label: string): string {
  const parent = configuredRoot ?? os.tmpdir();
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, `gg-${label}-`));
}

export async function withTempRoot<T>(
  label: string,
  callback: (root: string) => Promise<T> | T,
): Promise<T> {
  const root = createTempRoot(label);
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function initRepo(root: string, name = 'repo'): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  expectSuccess(command('git', ['init', '-q', '-b', 'main', repo], { cwd: root }));
  expectSuccess(git(repo, 'config', 'user.name', 'gg Test'));
  expectSuccess(git(repo, 'config', 'user.email', 'gg-test@example.invalid'));
  expectSuccess(git(repo, 'config', 'commit.gpgSign', 'false'));
  expectSuccess(git(repo, 'config', 'core.hooksPath', '/dev/null'));
  writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  expectSuccess(git(repo, 'add', 'base.txt'));
  expectSuccess(git(repo, 'commit', '-q', '-m', 'initial'));
  return repo;
}

export function createBareRemote(root: string, repo: string): string {
  const bare = path.join(root, 'remote.git');
  expectSuccess(
    command('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { cwd: root }),
  );
  expectSuccess(git(repo, 'remote', 'add', 'origin', bare));
  expectSuccess(git(repo, 'push', '-q', '-u', 'origin', 'main'));
  return bare;
}

export function write(repo: string, file: string, contents: string): void {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

export function read(repo: string, file: string): string {
  return readFileSync(path.join(repo, file), 'utf8');
}

export function head(repo: string, revision = 'HEAD'): string {
  const result = git(repo, 'rev-parse', revision);
  expectSuccess(result);
  return result.stdout.trim();
}

export function expectSuccess(result: CommandResult): void {
  if (result.status !== 0) {
    throw new Error(
      `command failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

export function installFakeGh(root: string, state: object): NodeJS.ProcessEnv {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'gh');
  copyFileSync(path.resolve('tests/fixtures/fake-gh.mjs'), executable);
  chmodSync(executable, 0o755);
  const statePath = path.join(root, 'fake-gh-state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    GG_FAKE_GH_STATE: statePath,
  };
}

export function stateFrom(env: NodeJS.ProcessEnv): any {
  const statePath = env.GG_FAKE_GH_STATE;
  if (!statePath || !existsSync(statePath)) throw new Error('fake gh state is missing');
  return JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
}
