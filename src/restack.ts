import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GitCommandError } from './git.js';
import { ggError, UserError } from './errors.js';
import type { Git, WorktreeSnapshot } from './git.js';
import { StackGraph } from './graph.js';
import { atomicWrite, type MetadataSnapshot, type MetadataStore } from './metadata.js';
import type { Output } from './output.js';
import { renderRestackResult } from './restack-output.js';

interface ReplaySuccess {
  kind: 'success';
  head: string;
}

interface ReplayConflict {
  kind: 'conflict';
}

type ReplayResult = ReplaySuccess | ReplayConflict;

interface ActiveRebase {
  branch: string;
  parent: string;
  oldHead: string;
  oldBase: string;
  newBase: string;
  pendingParent?: string;
}

interface CreatedBranchState {
  name: string;
  parentHead: string;
  worktree: WorktreeSnapshot;
  expectedHead?: string;
}

export interface OperationState {
  version: 1;
  command: string;
  currentBranchOverride: string;
  ownerGitDir: string;
  refs: Record<string, string>;
  expectedRefs: Record<string, string>;
  metadata: MetadataSnapshot;
  expectedMetadata: MetadataSnapshot;
  pendingMetadata?: MetadataSnapshot;
  queue: string[];
  originalQueue: string[];
  pendingParents?: Record<string, string>;
  active?: ActiveRebase;
  createdBranch?: CreatedBranchState;
  eventId: string;
}

export interface RestackQueueOptions {
  command: string;
  haltOnConflict: boolean;
  quiet?: boolean;
  warnOnConflict?: (branch: string, parent: string) => void;
}

interface CommitMetadata {
  authorName: string;
  authorEmail: string;
  authorDate: string;
  message: string;
}

export class ConflictHalt extends UserError {
  constructor(message: string) {
    super(message, { raw: true });
    this.name = 'ConflictHalt';
  }
}

export class RestackEngine {
  constructor(
    readonly git: Git,
    readonly store: MetadataStore,
    readonly output: Output,
    readonly verify: boolean,
  ) {}

  async restack(
    branch: string,
    scope: 'stack' | 'downstack' | 'upstack' | 'only',
    command: string,
  ): Promise<void> {
    this.ensureNotBlocked();
    const graph = new StackGraph(this.git, this.store);
    graph.require(branch);
    const queue = graph.restackOrder(branch, scope);
    const relations = queue.map((name) => {
      const parent = graph.parent(name);
      if (!parent) throw ggError(`Tracked metadata for ${name} has no parent.`);
      return { branch: name, parent };
    });
    await this.runQueue(queue, { command, haltOnConflict: true, quiet: true });
    renderRestackResult(this.output, relations);
  }

  async restackDescendantsWithoutHalting(
    branch: string,
    conflictMessage: string,
  ): Promise<boolean> {
    const graph = new StackGraph(this.git, this.store);
    const queue = graph.descendants(branch);
    return this.runQueueWithoutJournal(queue, (failed) => {
      this.output.warning(`${failed} could not be restacked cleanly.`);
      this.output.line(conflictMessage);
    });
  }

  async move(source: string, target: string, only: boolean, command: string): Promise<void> {
    this.ensureNotBlocked();
    const graph = new StackGraph(this.git, this.store);
    const row = graph.require(source);
    graph.require(target);
    if (source === graph.trunk) {
      throw ggError('Cannot perform this operation on the trunk branch.');
    }
    if (source === target) throw ggError(`Cannot set parent of ${source} to itself!`);
    if (graph.isDescendant(target, source)) {
      throw ggError(
        `Cannot set ${target} as the parent of ${source} because it's a child of it!\nERROR: Did you mean to use gg move? `,
      );
    }
    if (!row.parentBranchName) throw ggError(`Branch ${source} has no tracked parent.`);

    const pendingParents: Record<string, string> = { [source]: target };
    let queue: string[];
    if (only) {
      queue = [];
      for (const child of graph.children(source)) {
        pendingParents[child] = row.parentBranchName;
        queue.push(...graph.descendants(child, true));
      }
      queue.push(source);
    } else {
      queue = graph.descendants(source, true);
    }

    this.announceQueue(queue, 'Branches to move and restack:');

    const state = this.createState(command, queue);
    state.pendingParents = pendingParents;
    this.writeState(state);
    try {
      await this.continueQueue(state, { command, haltOnConflict: true });
      this.finishState(state);
    } catch (error) {
      if (error instanceof ConflictHalt) throw error;
      this.rollback(state);
      throw error;
    }
  }

  async createAndInsertBranch(
    name: string,
    parent: string,
    children: string[],
    worktree: WorktreeSnapshot,
    createBranch: (checkpoint: () => void) => Promise<void>,
  ): Promise<void> {
    this.ensureNotBlocked();
    const graph = new StackGraph(this.git, this.store);
    graph.require(parent);
    const pendingParents: Record<string, string> = {};
    const queue: string[] = [];
    const seen = new Set<string>();
    for (const child of children) {
      if (graph.parent(child) !== parent) {
        throw ggError(`Cannot insert ${name}: ${child} is no longer a direct child of ${parent}.`);
      }
      for (const branch of graph.descendants(child, true)) {
        if (seen.has(branch)) continue;
        if (this.git.isBranchCheckedOutElsewhere(branch)) {
          throw ggError(
            `Cannot insert ${name} because ${branch} is checked out in another worktree.`,
          );
        }
        seen.add(branch);
        queue.push(branch);
      }
      pendingParents[child] = name;
    }

    const state = this.createState(`branch create ${name} --insert`, queue);
    state.currentBranchOverride = name;
    state.pendingParents = pendingParents;
    state.createdBranch = {
      name,
      parentHead: this.git.head(parent),
      worktree,
    };
    this.writeState(state);
    const checkpoint = (): void => this.checkpointCreatedBranch(state);
    try {
      await createBranch(checkpoint);
      checkpoint();
      await this.continueQueue(state, {
        command: state.command,
        haltOnConflict: true,
        quiet: true,
      });
      this.finishState(state);
    } catch (error) {
      if (error instanceof ConflictHalt) throw error;
      this.rollback(state);
      throw error;
    }
  }

  async runQueue(queue: string[], options: RestackQueueOptions): Promise<void> {
    if (queue.length === 0) return;
    const current = this.git.tryBranch();
    if (current && queue.includes(current) && this.git.hasStagedChanges()) {
      throw ggError(`Cannot restack checked out branch ${current} with changes staged.`);
    }
    if (!options.quiet) this.announceQueue(queue, 'Branches to restack:');
    const state = this.createState(options.command, queue);
    this.writeState(state);
    try {
      await this.continueQueue(state, options);
      this.finishState(state);
    } catch (error) {
      if (error instanceof ConflictHalt) throw error;
      this.rollback(state);
      throw error;
    }
  }

  async runQueueWithoutJournal(
    queue: string[],
    onConflict: (branch: string, parent: string) => void,
  ): Promise<boolean> {
    let conflicted = false;
    await this.runQueue(queue, {
      command: 'automatic restack',
      haltOnConflict: false,
      warnOnConflict: (failed, parent) => {
        conflicted = true;
        onConflict(failed, parent);
      },
    });
    return !conflicted;
  }

  async continue(all = false): Promise<void> {
    const state = this.readState();
    if (!state) {
      throw ggError('No gg operation to continue.');
    }
    this.requireOwningWorktree(state, 'continue');
    if (!this.git.hasRebase()) {
      await this.restartInterruptedCleanOperation(state);
      return;
    }
    if (!state.active) throw ggError('Interrupted operation state has no active branch.');
    if (all) this.git.run(['add', '-A']);
    if (this.unmergedFiles().length > 0) {
      throw new ConflictHalt(
        `Rebase conflict is not yet resolved.\n${this.recoveryBlock(state.active, state.queue)}`,
      );
    }

    const result = this.git.run(['-c', 'core.editor=true', 'rebase', '--continue'], {
      allowFailure: true,
      env: { GIT_EDITOR: 'true' },
    });
    if (result.status !== 0) {
      if (this.git.hasRebase()) {
        const active = state.active;
        this.writeState(state);
        throw new ConflictHalt(
          `Rebase conflict is not yet resolved.\n${this.recoveryBlock(active, state.queue)}`,
        );
      }
      throw new GitCommandError(
        ['-c', 'core.editor=true', 'rebase', '--continue'],
        result.stdout,
        result.stderr,
        result.status,
      );
    }

    const active = state.active;
    const branchHead = this.git.head(active.branch);
    state.expectedRefs[active.branch] = branchHead;
    this.prepareMetadataExpectation(
      state,
      active.branch,
      active.newBase,
      branchHead,
      active.pendingParent,
    );
    this.store.updateAfterRestack(active.branch, active.newBase, branchHead, active.pendingParent);
    this.commitMetadataExpectation(state);
    this.output.line(`Resolved rebase conflict for ${active.branch}.`);
    delete state.active;
    this.writeState(state);
    try {
      await this.continueQueue(state, { command: state.command, haltOnConflict: true });
      this.finishState(state);
    } catch (error) {
      if (error instanceof ConflictHalt) throw error;
      this.rollback(state);
      throw error;
    }
  }

  abort(): string {
    const state = this.readState();
    if (!state) throw ggError('No gg operation to abort.');
    this.requireOwningWorktree(state, 'abort');
    this.rollback(state);
    return state.command;
  }

  ensureNotBlocked(): void {
    if (this.git.hasRebase()) {
      throw ggError(
        'This operation is blocked during a rebase.\nResolve it with gg continue or cancel it with gg abort.',
      );
    }
    if (existsSync(this.store.operationPath)) {
      throw ggError(
        'A gg operation was interrupted. Run gg continue to resume it or gg abort to restore its starting state.',
      );
    }
  }

  createState(command: string, queue: string[]): OperationState {
    const refs = Object.fromEntries(this.git.localBranchHeads());
    const metadata = this.store.snapshot();
    return {
      version: 1,
      command,
      currentBranchOverride: this.git.branch(),
      ownerGitDir: this.git.gitDir,
      refs,
      expectedRefs: { ...refs },
      metadata,
      expectedMetadata: structuredClone(metadata),
      queue: [...queue],
      originalQueue: [...queue],
      eventId: randomUUID(),
    };
  }

  writeState(state: OperationState): void {
    if (state.ownerGitDir !== this.git.gitDir) {
      throw ggError('Cannot update an operation owned by another linked worktree.');
    }
    const serialized = JSON.stringify(state, null, 2);
    if (existsSync(this.store.operationPath)) {
      const owner = this.readState();
      if (owner?.eventId !== state.eventId) {
        throw ggError(
          'Another gg operation acquired the repository while this command was starting.',
        );
      }
      atomicWrite(this.store.operationPath, serialized, 0o600);
    } else {
      try {
        writeFileSync(this.store.operationPath, serialized, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw ggError('Another gg operation is already mutating this repository.');
        }
        throw error;
      }
    }
    atomicWrite(
      this.store.continuePath,
      JSON.stringify({
        currentBranchOverride: state.currentBranchOverride,
        branchesToRestack: state.queue,
        rebasedBranchBase: state.active?.newBase,
        eventId: state.eventId,
      }),
      0o600,
    );
  }

  readState(): OperationState | undefined {
    if (!existsSync(this.store.operationPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.store.operationPath, 'utf8')) as OperationState;
    } catch {
      throw ggError('Could not read interrupted gg operation state.');
    }
  }

  private async restartInterruptedCleanOperation(state: OperationState): Promise<void> {
    if (state.createdBranch) {
      if (!state.active && state.queue.length === 0 && this.matchesExpectedState(state)) {
        this.finishState(state);
        return;
      }
      this.rollback(state);
      throw ggError(
        `Interrupted ${state.command} was rolled back safely. Run the branch creation command again.`,
      );
    }
    const queue = state.originalQueue ?? [
      ...(state.active ? [state.active.branch] : []),
      ...state.queue,
    ];
    const pendingParents = state.pendingParents ? { ...state.pendingParents } : undefined;
    const command = state.command;
    this.rollback(state);
    const restarted = this.createState(command, queue);
    if (pendingParents) restarted.pendingParents = pendingParents;
    this.writeState(restarted);
    try {
      await this.continueQueue(restarted, { command, haltOnConflict: true });
      this.finishState(restarted);
    } catch (error) {
      if (error instanceof ConflictHalt) throw error;
      this.rollback(restarted);
      throw error;
    }
  }

  finishState(state: OperationState): void {
    if (this.git.tryBranch() !== state.currentBranchOverride) {
      this.git.switch(state.currentBranchOverride);
    }
    atomicWrite(this.store.continuePath, JSON.stringify({ branchesToRestack: [] }), 0o600);
    if (existsSync(this.store.operationPath)) unlinkSync(this.store.operationPath);
  }

  rollback(state: OperationState): void {
    for (const [branch, original] of Object.entries(state.refs)) {
      const current = this.git.tryHead(branch);
      const expected = state.expectedRefs?.[branch] ?? original;
      if (!current) {
        throw ggError(
          `Cannot abort because branch ${branch} was deleted outside the interrupted gg operation. Restore that branch before retrying.`,
        );
      }
      if (
        current !== original &&
        current !== expected &&
        !this.isCompletedActiveRebase(state, branch, current)
      ) {
        throw ggError(
          `Cannot abort because branch ${branch} changed outside the interrupted gg operation. Resolve that change before retrying.`,
        );
      }
    }
    const created = state.createdBranch;
    if (created) {
      const current = this.git.tryHead(created.name);
      if (current && current !== created.parentHead && current !== created.expectedHead) {
        throw ggError(
          `Cannot abort because newly created branch ${created.name} changed outside the interrupted gg operation.`,
        );
      }
    }
    const currentMetadata = this.store.snapshot();
    const expectedMetadata = state.expectedMetadata ?? state.metadata;
    const currentSignature = metadataTopologySignature(currentMetadata);
    const acceptedMetadata = [state.metadata, expectedMetadata, state.pendingMetadata]
      .filter((value): value is MetadataSnapshot => value !== undefined)
      .map(metadataTopologySignature);
    if (!acceptedMetadata.includes(currentSignature)) {
      throw ggError(
        'Cannot abort because stack metadata changed outside the interrupted gg operation.',
      );
    }
    if (this.git.hasRebase()) {
      const aborted = this.git.run(['rebase', '--abort'], { allowFailure: true });
      if (aborted.status !== 0 || this.git.hasRebase()) {
        throw ggError(
          'Git could not abort the active rebase; recovery state was preserved. Resolve the Git rebase before retrying gg abort.',
        );
      }
    }
    if (created) {
      this.git.run(['symbolic-ref', 'HEAD', `refs/heads/${created.worktree.branch}`]);
    } else if (
      this.git.branchExists(state.currentBranchOverride) &&
      this.git.tryBranch() !== state.currentBranchOverride
    ) {
      this.git.switch(state.currentBranchOverride);
    }
    const checkedOut = this.git.tryBranch();
    for (const [branch, revision] of Object.entries(state.refs)) {
      if (!this.git.branchExists(branch)) continue;
      const current = this.git.head(branch);
      if (current === revision) continue;
      if (!created && branch === checkedOut) {
        this.git.run(['reset', '-q', '--keep', revision]);
      } else {
        this.git.updateRef(branch, revision, current);
      }
    }
    this.store.restore(state.metadata);
    if (created) {
      this.git.restoreWorktreeSnapshot(created.worktree);
      const createdHead = this.git.tryHead(created.name);
      if (createdHead) this.git.deleteRef(created.name, createdHead);
    }
    atomicWrite(this.store.continuePath, JSON.stringify({ branchesToRestack: [] }), 0o600);
    if (existsSync(this.store.operationPath)) unlinkSync(this.store.operationPath);
  }

  previewReplay(branchRevision: string, oldBase: string, newBase: string): ReplayResult {
    if (!this.git.isAncestor(oldBase, branchRevision)) return { kind: 'conflict' };
    const list = this.git.capture([
      'rev-list',
      '--reverse',
      '--topo-order',
      '--parents',
      `${oldBase}..${branchRevision}`,
    ]);
    const commits: Array<{ commit: string; parent: string }> = [];
    for (const line of list.split('\n').filter(Boolean)) {
      const parts = line.split(' ');
      if (parts.length !== 2) return { kind: 'conflict' };
      commits.push({ commit: parts[0]!, parent: parts[1]! });
    }
    const metadata = this.loadCommitMetadata(commits.map(({ commit }) => commit));
    let nextParent = newBase;
    for (const { commit, parent } of commits) {
      const commitMetadata = metadata.get(commit);
      if (!commitMetadata) return { kind: 'conflict' };
      const merge = this.git.run(
        ['merge-tree', '--write-tree', '--messages', `--merge-base=${parent}`, nextParent, commit],
        { allowFailure: true },
      );
      if (merge.status !== 0) return { kind: 'conflict' };
      const tree = merge.stdout.split('\n')[0]?.trim();
      if (!tree) return { kind: 'conflict' };
      nextParent = this.recreateCommit(commitMetadata, tree, nextParent);
    }
    return { kind: 'success', head: nextParent };
  }

  private async continueQueue(state: OperationState, options: RestackQueueOptions): Promise<void> {
    while (state.queue.length > 0) {
      const branch = state.queue.shift();
      if (!branch) break;
      const row = this.store.get(branch);
      if (!row?.parentBranchName || !row.parentBranchRevision) {
        throw ggError(`Tracked metadata for ${branch} has no valid parent revision.`);
      }
      const pendingParent = state.pendingParents?.[branch];
      const effectiveParent = pendingParent ?? row.parentBranchName;
      const newBase = this.git.head(effectiveParent);
      const oldHead = this.git.head(branch);
      if (!this.git.isAncestor(row.parentBranchRevision, oldHead)) {
        throw ggError(
          `Branch ${branch} has diverged from its recorded parent revision and cannot be restacked safely. Retrack or repair it first.`,
        );
      }
      const active: ActiveRebase = {
        branch,
        parent: effectiveParent,
        oldHead,
        oldBase: row.parentBranchRevision,
        newBase,
      };
      if (pendingParent) active.pendingParent = pendingParent;
      state.active = active;
      this.writeState(state);
      if (newBase === row.parentBranchRevision) {
        this.prepareMetadataExpectation(state, branch, newBase, oldHead, pendingParent);
        this.store.updateAfterRestack(branch, newBase, oldHead, pendingParent);
        if (!options.quiet) {
          this.output.line(
            pendingParent
              ? `Restacked ${branch} on ${effectiveParent}.`
              : `${branch} does not need to be restacked on ${effectiveParent}.`,
          );
        }
        this.commitMetadataExpectation(state);
        delete state.active;
        this.writeState(state);
        continue;
      }
      const replay = this.previewReplay(oldHead, row.parentBranchRevision, newBase);
      if (replay.kind === 'success') {
        if (this.git.head(effectiveParent) !== newBase) {
          throw ggError(
            `Cannot restack ${branch} because parent ${effectiveParent} changed during replay. Retry the operation.`,
          );
        }
        state.expectedRefs[branch] = replay.head;
        this.prepareMetadataExpectation(state, branch, newBase, replay.head, pendingParent);
        this.moveBranch(branch, replay.head, oldHead);
        this.store.updateAfterRestack(branch, newBase, replay.head, pendingParent);
        this.commitMetadataExpectation(state);
        if (!options.quiet) this.output.line(`Restacked ${branch} on ${effectiveParent}.`);
        delete state.active;
        this.writeState(state);
        continue;
      }
      if (!options.haltOnConflict) {
        options.warnOnConflict?.(branch, effectiveParent);
        const graph = new StackGraph(this.git, this.store);
        state.queue = state.queue.filter(
          (candidate) => !graph.ancestors(candidate).includes(branch),
        );
        delete state.active;
        this.writeState(state);
        continue;
      }
      await this.materializeConflict(state, active, options.quiet ?? false);
    }
  }

  async materializeConflict(
    state: OperationState,
    active: ActiveRebase,
    quiet = false,
  ): Promise<void> {
    if (this.git.hasAnyChanges()) {
      throw ggError(
        `Cannot expose the rebase conflict for ${active.branch} while the worktree has changes. Commit or stash them, then rerun gg restack.`,
      );
    }
    if (this.git.head(active.branch) !== active.oldHead) {
      throw ggError(
        `Cannot restack ${active.branch} because it changed during replay. Retry the operation.`,
      );
    }
    if (this.git.head(active.parent) !== active.newBase) {
      throw ggError(
        `Cannot restack ${active.branch} because parent ${active.parent} changed during replay. Retry the operation.`,
      );
    }
    if (this.git.branch() !== active.branch) this.git.switch(active.branch);
    const args = ['rebase', '--empty=keep', '--reapply-cherry-picks'];
    if (!this.verify) args.push('--no-verify');
    args.push('--onto', active.newBase, active.oldBase, active.branch);
    const result = this.git.run(args, { allowFailure: true });
    if (result.status === 0) {
      const head = this.git.head(active.branch);
      state.expectedRefs[active.branch] = head;
      this.prepareMetadataExpectation(
        state,
        active.branch,
        active.newBase,
        head,
        active.pendingParent,
      );
      this.store.updateAfterRestack(active.branch, active.newBase, head, active.pendingParent);
      this.commitMetadataExpectation(state);
      if (!quiet) this.output.line(`Restacked ${active.branch} on ${active.parent}.`);
      delete state.active;
      this.writeState(state);
      return;
    }
    if (!this.git.hasRebase()) {
      throw new GitCommandError(args, result.stdout, result.stderr, result.status);
    }
    this.writeState(state);
    throw new ConflictHalt(
      `Hit conflict restacking ${active.branch} on ${active.parent}.\n${this.recoveryBlock(active, state.queue)}`,
    );
  }

  private recreateCommit(metadata: CommitMetadata, tree: string, parent: string): string {
    return this.git.capture(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', parent], {
      input: `${metadata.message}\n`,
      env: {
        GIT_AUTHOR_NAME: metadata.authorName,
        GIT_AUTHOR_EMAIL: metadata.authorEmail,
        GIT_AUTHOR_DATE: metadata.authorDate,
      },
    });
  }

  private loadCommitMetadata(commits: string[]): Map<string, CommitMetadata> {
    if (commits.length === 0) return new Map();
    const data = this.git.run(
      ['log', '--no-walk=unsorted', '--format=%H%x00%an%x00%ae%x00%aI%x00%B%x00%x1e', '--stdin'],
      { input: `${commits.join('\n')}\n` },
    ).stdout;
    const result = new Map<string, CommitMetadata>();
    for (const record of data.split('\x1e')) {
      let normalized = record.replace(/^\n/, '');
      if (normalized.endsWith('\0\n')) normalized = normalized.slice(0, -2);
      else if (normalized.endsWith('\0')) normalized = normalized.slice(0, -1);
      if (!normalized) continue;
      const [commit = '', authorName = '', authorEmail = '', authorDate = '', ...messageParts] =
        normalized.split('\0');
      result.set(commit, {
        authorName,
        authorEmail,
        authorDate,
        message: messageParts.join('\0').replace(/\n$/, ''),
      });
    }
    return result;
  }

  private moveBranch(branch: string, next: string, previous: string): void {
    if (this.git.head(branch) !== previous) {
      throw ggError(
        `Cannot restack ${branch} because it changed during replay. Retry the operation.`,
      );
    }
    if (this.git.tryBranch() === branch) {
      if (this.git.hasStagedChanges()) {
        throw ggError(`Cannot restack checked out branch ${branch} with changes staged.`);
      }
      this.git.run(['reset', '-q', '--keep', next]);
    } else {
      if (this.git.isBranchCheckedOutElsewhere(branch)) {
        throw ggError(`Cannot restack ${branch} because it is checked out in another worktree.`);
      }
      this.git.updateRef(branch, next, previous);
    }
  }

  private prepareMetadataExpectation(
    state: OperationState,
    branch: string,
    parentRevision: string,
    branchRevision: string,
    newParent?: string,
  ): void {
    state.pendingMetadata = this.store.previewAfterRestack(
      branch,
      parentRevision,
      branchRevision,
      newParent,
    );
    this.writeState(state);
  }

  private commitMetadataExpectation(state: OperationState): void {
    if (!state.pendingMetadata) throw new Error('Missing planned metadata state.');
    state.expectedMetadata = state.pendingMetadata;
    delete state.pendingMetadata;
  }

  private checkpointCreatedBranch(state: OperationState): void {
    const created = state.createdBranch;
    if (!created) throw new Error('Missing created-branch recovery state.');
    const head = this.git.tryHead(created.name);
    if (head) {
      created.expectedHead = head;
      state.expectedRefs[created.name] = head;
    }
    state.expectedMetadata = this.store.snapshot();
    this.writeState(state);
  }

  private matchesExpectedState(state: OperationState): boolean {
    for (const [branch, expected] of Object.entries(state.expectedRefs)) {
      if (this.git.tryHead(branch) !== expected) return false;
    }
    return (
      metadataTopologySignature(this.store.snapshot()) ===
      metadataTopologySignature(state.expectedMetadata)
    );
  }

  private requireOwningWorktree(state: OperationState, action: string): void {
    if (state.ownerGitDir !== this.git.gitDir) {
      throw ggError(
        `Cannot ${action} this operation from another linked worktree. Run gg ${action} in the worktree where it started.`,
      );
    }
  }

  private announceQueue(queue: string[], heading: string): void {
    if (queue.length < 2) return;
    this.output.line(heading);
    this.output.lines(queue.map((branch) => `  ${branch}`));
  }

  private isCompletedActiveRebase(state: OperationState, branch: string, current: string): boolean {
    const active = state.active;
    if (!active || active.branch !== branch || !this.git.isAncestor(active.newBase, current)) {
      return false;
    }
    const action = this.git.capture(['reflog', 'show', '-1', '--format=%gs', branch]);
    return action.startsWith('rebase (finish):');
  }

  private unmergedFiles(): string[] {
    const value = this.git.capture(['diff', '--name-only', '--diff-filter=U']);
    return value ? value.split('\n').filter(Boolean) : [];
  }

  private recoveryBlock(active: ActiveRebase, queue: string[]): string {
    const files = this.unmergedFiles();
    const fileBlock = files.length > 0 ? files.map((file) => `  ${file}`).join('\n') : '  (none)';
    const queued = queue.length > 0 ? queue.map((branch) => `  ◯ ${branch}`).join('\n') : '';
    return [
      'Unmerged files:',
      fileBlock,
      '',
      `You are here (resolving ${active.branch}):`,
      queued,
      `  ◉ ${active.branch}`,
      `  ◯ ${active.parent}`,
      '',
      '1. Resolve the conflicts listed above.',
      '2. Stage the resolved files with git add, or run gg continue --all.',
      '3. Run gg continue.',
      '',
      "It's safe to cancel the ongoing rebase with gg abort.",
    ]
      .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
      .join('\n');
  }
}

function metadataTopologySignature(snapshot: MetadataSnapshot): string {
  return JSON.stringify(
    snapshot.rows.map((row) => ({
      branchName: row.branchName,
      parentBranchName: row.parentBranchName,
      parentBranchRevision: row.parentBranchRevision,
      lastSubmittedVersion: row.lastSubmittedVersion,
      lastSubmittedBaseBranch: row.lastSubmittedBaseBranch,
      state: row.state,
      siblingOrder: row.siblingOrder,
    })),
  );
}
