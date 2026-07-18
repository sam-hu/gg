import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ggError } from './errors.js';
import type { Git } from './git.js';

interface LeaseOwner {
  token: string;
  pid: number;
  command: string;
  gitDir: string;
  startedAt: string;
}

export class MutationLease {
  private released = false;

  private constructor(
    readonly file: string,
    private readonly owner: LeaseOwner,
  ) {}

  static acquire(git: Git, command: string): MutationLease {
    const file = path.join(git.commonGitDir, '.gg_mutation_lock');
    const owner: LeaseOwner = {
      token: randomUUID(),
      pid: process.pid,
      command,
      gitDir: git.gitDir,
      startedAt: new Date().toISOString(),
    };
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(owner, null, 2), 'utf8');
      closeSync(descriptor);
      return new MutationLease(file, owner);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        try {
          unlinkSync(file);
        } catch {
          // Preserve the original filesystem error.
        }
        throw error;
      }
      throw leaseUnavailable(file);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      const current = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LeaseOwner>;
      if (current.token === this.owner.token) unlinkSync(this.file);
    } catch {
      // Never remove a lock that cannot be proven to belong to this process.
    }
  }
}

function leaseUnavailable(file: string): Error {
  let owner: Partial<LeaseOwner> | undefined;
  try {
    owner = JSON.parse(readFileSync(file, 'utf8')) as Partial<LeaseOwner>;
  } catch {
    // The malformed lock must be inspected rather than removed automatically.
  }
  const command = typeof owner?.command === 'string' ? ` running gg ${owner.command}` : '';
  const worktree = typeof owner?.gitDir === 'string' ? ` in ${owner.gitDir}` : '';
  if (typeof owner?.pid === 'number' && processIsRunning(owner.pid)) {
    return ggError(
      `Another gg process (${owner.pid}) is${command}${worktree}. Wait for it to finish before running a mutating command.`,
    );
  }
  return ggError(
    `A stale or unreadable gg mutation lock exists at ${file}. Verify that no gg process is running, then remove that file and retry.`,
  );
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
