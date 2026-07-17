import type { Git } from './git.js';

export type StagingAction = 'all' | 'update' | 'patch';

export interface StagingOptions {
  all?: boolean;
  update?: boolean;
  patch?: boolean;
}

export const STAGING_CHOICES = [
  { name: 'Commit all file changes (--all)', value: 'all' },
  { name: 'Commit all changes to tracked files (--update)', value: 'update' },
  { name: 'Select changes to commit (--patch)', value: 'patch' },
] as const;

export function stageRequestedChanges(git: Git, options: StagingOptions): boolean {
  const action = options.all
    ? 'all'
    : options.update
      ? 'update'
      : options.patch
        ? 'patch'
        : undefined;
  if (!action) return false;
  stageChanges(git, action);
  return true;
}

export function stageChanges(git: Git, action: StagingAction): void {
  if (action === 'all') {
    git.run(['add', '-A']);
  } else if (action === 'update') {
    git.run(['add', '-u']);
  } else {
    git.run(['add', '--patch'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  }
}
