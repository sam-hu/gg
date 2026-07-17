import { ggError } from './errors.js';
import type { Git } from './git.js';
import type { BranchMetadata, MetadataStore } from './metadata.js';

export class StackGraph {
  readonly trunk: string;
  private readonly rows: Map<string, BranchMetadata>;

  constructor(
    private readonly git: Git,
    private readonly store: MetadataStore,
  ) {
    this.trunk = store.trunk();
    this.rows = new Map(store.all().map((row) => [row.branchName, row]));
  }

  refresh(): { diverged: string[]; missing: string[] } {
    return this.validateRows(true);
  }

  validate(): { diverged: string[]; missing: string[] } {
    return this.validateRows(false);
  }

  private validateRows(persist: boolean): { diverged: string[]; missing: string[] } {
    const diverged: string[] = [];
    const missing: string[] = [];
    const changed: BranchMetadata[] = [];
    const branchHeads = this.git.localBranchHeads();
    for (const row of this.rows.values()) {
      const before = JSON.stringify(row);
      const previousHead = row.branchRevision;
      const head = branchHeads.get(row.branchName);
      if (!head) {
        row.validationResult = 'BAD_PARENT_NAME';
        missing.push(row.branchName);
        if (JSON.stringify(row) !== before) changed.push(row);
        continue;
      }
      row.branchRevision = head;
      if (row.branchName === this.trunk) {
        row.validationResult = 'TRUNK';
        row.parentHeadRevision = null;
        if (JSON.stringify(row) !== before) changed.push(row);
        continue;
      }
      const parentHead = row.parentBranchName ? branchHeads.get(row.parentBranchName) : undefined;
      if (!row.parentBranchName || !parentHead) {
        row.validationResult = 'BAD_PARENT_NAME';
        diverged.push(row.branchName);
        if (JSON.stringify(row) !== before) changed.push(row);
        continue;
      }
      // Commits are immutable: if a previously valid branch still points to
      // the same commit, its recorded parent revision is still its ancestor.
      if (row.validationResult === 'BAD_PARENT_REVISION' && (!persist || previousHead === head)) {
        diverged.push(row.branchName);
        continue;
      }
      if (persist && (previousHead !== head || !row.parentBranchRevision)) {
        if (
          !row.parentBranchRevision ||
          !this.git.tryHead(row.parentBranchRevision) ||
          !this.git.isAncestor(row.parentBranchRevision, row.branchName)
        ) {
          row.validationResult = 'BAD_PARENT_REVISION';
          diverged.push(row.branchName);
          if (JSON.stringify(row) !== before) changed.push(row);
          continue;
        }
      }
      row.parentHeadRevision = parentHead;
      row.validationResult = 'VALID';
      if (JSON.stringify(row) !== before) changed.push(row);
    }
    if (persist && changed.length > 0) {
      this.store.transaction(() => {
        for (const row of changed) this.store.put(row);
      });
    }
    return { diverged, missing };
  }

  get(branch: string): BranchMetadata | undefined {
    return this.rows.get(branch);
  }

  require(branch: string): BranchMetadata {
    const row = this.get(branch);
    if (!row) {
      throw ggError(
        `Cannot perform this operation on untracked branch ${branch}.\nCreate it with gg branch create or track it with gg track.`,
      );
    }
    return row;
  }

  parent(branch: string): string | undefined {
    return this.get(branch)?.parentBranchName ?? undefined;
  }

  children(branch: string, lexical = false): string[] {
    const row = this.get(branch);
    // Metadata deliberately survives a branch being deleted so `log` can report
    // the missing ref. Traversal must not treat those stale rows as navigable.
    const children = (row?.children ?? []).filter(
      (child) => this.rows.has(child) && this.git.branchExists(child),
    );
    return lexical ? children.toSorted((left, right) => left.localeCompare(right)) : children;
  }

  ancestors(branch: string, includeSelf = false): string[] {
    const result: string[] = includeSelf ? [branch] : [];
    const seen = new Set<string>(result);
    let cursor = this.parent(branch);
    while (cursor) {
      if (seen.has(cursor)) throw ggError('Tracked branch metadata contains a cycle.');
      seen.add(cursor);
      result.push(cursor);
      cursor = this.parent(cursor);
    }
    return result;
  }

  descendants(branch: string, includeSelf = false, lexical = false): string[] {
    const result: string[] = includeSelf ? [branch] : [];
    const seen = new Set<string>(result);
    const visit = (parent: string): void => {
      for (const child of this.children(parent, lexical)) {
        if (seen.has(child)) throw ggError('Tracked branch metadata contains a cycle.');
        seen.add(child);
        result.push(child);
        visit(child);
      }
    };
    visit(branch);
    return result;
  }

  leaves(branch: string): string[] {
    const result: string[] = [];
    const visit = (current: string): void => {
      const children = this.children(current, true);
      if (children.length === 0) {
        result.push(current);
        return;
      }
      for (const child of children) visit(child);
    };
    visit(branch);
    return result;
  }

  path(from: string, descendant: string): string[] | undefined {
    if (!this.git.branchExists(descendant)) return undefined;
    const candidate = this.ancestors(descendant, true).reverse();
    if (candidate.some((branch) => !this.git.branchExists(branch))) return undefined;
    const index = candidate.indexOf(from);
    return index >= 0 ? candidate.slice(index) : undefined;
  }

  depth(branch: string): number {
    return this.ancestors(branch).length;
  }

  isDescendant(candidate: string, ancestor: string): boolean {
    return this.ancestors(candidate).includes(ancestor);
  }

  needsRestack(branch: string): boolean {
    const row = this.get(branch);
    if (!row?.parentBranchName || !row.parentBranchRevision) return false;
    const parentHead = this.git.tryHead(row.parentBranchName);
    return Boolean(parentHead && parentHead !== row.parentBranchRevision);
  }

  restackOrder(branch: string, scope: 'stack' | 'downstack' | 'upstack' | 'only'): string[] {
    if (scope === 'only') return branch === this.trunk ? [] : [branch];
    const down = this.ancestors(branch, true)
      .filter((name) => name !== this.trunk)
      .reverse();
    if (scope === 'downstack') return down;
    const up = this.descendants(branch, scope === 'upstack').filter((name) => name !== this.trunk);
    if (scope === 'upstack') return up;
    const seen = new Set<string>();
    return [...down, ...this.descendants(branch)].filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return name !== this.trunk;
    });
  }

  allRestackOrder(): string[] {
    return this.descendants(this.trunk, false).filter((name) => name !== this.trunk);
  }

  trackedBranches(): string[] {
    return [...this.rows.keys()];
  }
}
