import type { RepositoryContext } from './context.js';
import { ggError } from './errors.js';

export interface DeletedTrackedBranch {
  previousRevision: string;
  reparentedChildren: string[];
}

export function deleteTrackedBranch(
  context: RepositoryContext,
  branch: string,
  parent: string,
  expectedRevision?: string,
): DeletedTrackedBranch {
  if (context.git.isBranchCheckedOutElsewhere(branch)) {
    throw ggError(`Cannot delete ${branch} because it is checked out in another worktree.`);
  }

  const previousRevision = context.git.head(branch);
  if (expectedRevision && previousRevision !== expectedRevision) {
    throw ggError(
      `Cannot delete ${branch} because it changed from expected revision ${expectedRevision} to ${previousRevision}.`,
    );
  }
  const wasCurrent = context.git.tryBranch() === branch;
  if (wasCurrent) context.git.switch(parent);

  const metadataBefore = context.store.snapshot();
  try {
    const reparentedChildren = context.store
      .deleteAndReparent(branch, parent)
      .filter((child) => context.git.branchExists(child));
    context.git.deleteRef(branch, previousRevision);
    return { previousRevision, reparentedChildren };
  } catch (error) {
    context.store.restore(metadataBefore);
    if (wasCurrent) context.git.switch(branch);
    throw error;
  }
}
