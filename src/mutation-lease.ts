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

const recoverySuffix = '.recovery';

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
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        if (attempt === 0 && recoverStaleLease(file)) continue;
        throw leaseUnavailable(file);
      }
    }
    throw leaseUnavailable(file);
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

function recoverStaleLease(file: string): boolean {
  const recoveryFile = `${file}${recoverySuffix}`;
  const recoveryOwner: LeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    command: 'recover mutation lock',
    gitDir: path.dirname(file),
    startedAt: new Date().toISOString(),
  };
  if (!acquireRecoveryGuard(recoveryFile, recoveryOwner)) return false;

  try {
    const owner = readLeaseOwner(file);
    if (owner === undefined) return true;
    if (owner === null || processIsRunning(owner.pid)) return false;

    const current = readLeaseOwner(file);
    if (current?.token !== owner.token) return false;
    unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  } finally {
    try {
      const current = readLeaseOwner(recoveryFile);
      if (current?.token === recoveryOwner.token) unlinkSync(recoveryFile);
    } catch {
      // Never remove a recovery guard that cannot be proven to belong to this process.
    }
  }
}

function acquireRecoveryGuard(file: string, owner: LeaseOwner): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(owner, null, 2), 'utf8');
      closeSync(descriptor);
      descriptor = undefined;
      return true;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try {
          unlinkSync(file);
        } catch {
          // Preserve the original filesystem error.
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && recoverStaleRecoveryGuard(file)) continue;
      return false;
    }
  }
  return false;
}

function recoverStaleRecoveryGuard(file: string): boolean {
  const owner = readLeaseOwner(file);
  if (owner === undefined) return true;
  if (owner === null || processIsRunning(owner.pid)) return false;

  try {
    const current = readLeaseOwner(file);
    if (current?.token !== owner.token) return false;
    unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function readLeaseOwner(file: string): LeaseOwner | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  }
  if (!isLeaseOwner(parsed)) return null;
  return parsed;
}

function isLeaseOwner(value: unknown): value is LeaseOwner {
  if (typeof value !== 'object' || value === null) return false;
  const owner = value as Partial<LeaseOwner>;
  return (
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    typeof owner.pid === 'number' &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.command === 'string' &&
    typeof owner.gitDir === 'string' &&
    typeof owner.startedAt === 'string' &&
    Number.isFinite(Date.parse(owner.startedAt))
  );
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
