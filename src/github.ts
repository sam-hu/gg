import { spawnSync } from 'node:child_process';
import { ggError } from './errors.js';
import type { Git } from './git.js';
import { runCommand } from './git.js';

export interface GitHubRepository {
  host: string;
  owner: string;
  name: string;
  remote: string;
  pushUrl: string;
  baseRemote: string;
  headOwner: string;
}

export interface PullRequest {
  number: number;
  nodeId: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  requestedReviewers: string[];
  requestedTeams: string[];
}

export interface PullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface GitHubClient {
  preflight(repository: GitHubRepository): Promise<void>;
  listForHead(repository: GitHubRepository, branch: string): Promise<PullRequest[]>;
  create(repository: GitHubRepository, input: PullRequestInput): Promise<PullRequest>;
  update(
    repository: GitHubRepository,
    number: number,
    input: Partial<PullRequestInput>,
  ): Promise<PullRequest>;
  publish(repository: GitHubRepository, pullRequest: PullRequest): Promise<void>;
  requestReviewers(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    reviewers: string[],
    teams: string[],
  ): Promise<void>;
  listComments(repository: GitHubRepository, pullRequest: PullRequest): Promise<IssueComment[]>;
  comment(repository: GitHubRepository, pullRequest: PullRequest, body: string): Promise<void>;
  updateComment(repository: GitHubRepository, comment: IssueComment, body: string): Promise<void>;
  enableAutoMerge(repository: GitHubRepository, pullRequest: PullRequest): Promise<void>;
  reviewersForRerequest(repository: GitHubRepository, pullRequest: PullRequest): Promise<string[]>;
}

export function resolveRemote(git: Git, trunk: string): { name: string; url: string } {
  const configured = git.run(['config', '--get', `branch.${trunk}.remote`], { allowFailure: true });
  const remotes = git.capture(['remote']).split('\n').filter(Boolean);
  const candidate =
    configured.status === 0 && configured.stdout.trim() && configured.stdout.trim() !== '.'
      ? configured.stdout.trim()
      : remotes.includes('origin')
        ? 'origin'
        : remotes.length === 1
          ? remotes[0]!
          : undefined;
  if (!candidate) throw ggError('Could not determine which Git remote to use.');
  const url = git.capture(['remote', 'get-url', candidate]);
  return { name: candidate, url };
}

export function parseGitHubRepository(remote: string, url: string): GitHubRepository | undefined {
  const scp = /^(?:[^@]+@)?([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (scp) {
    const host = normalizeHost(scp[1]!);
    return {
      host,
      owner: scp[2]!,
      name: stripDotGit(scp[3]!),
      remote,
      pushUrl: url,
      baseRemote: remote,
      headOwner: scp[2]!,
    };
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    const pieces = parsed.pathname.replace(/^\//, '').split('/');
    if (pieces.length < 2) return undefined;
    return {
      host: normalizeHost(parsed.hostname),
      owner: pieces[0]!,
      name: stripDotGit(pieces.slice(1).join('/')),
      remote,
      pushUrl: url,
      baseRemote: remote,
      headOwner: pieces[0]!,
    };
  } catch {
    return undefined;
  }
}

export function resolveGitHubRepository(
  git: Git,
  remote: { name: string; url: string },
): GitHubRepository | undefined {
  const override = git.run(['config', '--get', 'gg.githubRepository'], { allowFailure: true });
  if (override.status === 0 && override.stdout.trim()) {
    const pieces = override.stdout.trim().split('/');
    if (pieces.length === 3) {
      return {
        host: pieces[0]!,
        owner: pieces[1]!,
        name: pieces[2]!,
        remote: remote.name,
        pushUrl: remote.url,
        baseRemote: remote.name,
        headOwner: pieces[1]!,
      };
    }
  }
  return parseGitHubRepository(remote.name, remote.url);
}

export function resolveSubmissionRepository(
  git: Git,
  trunk: string,
  branch: string,
): GitHubRepository | undefined {
  const base = resolveRemote(git, trunk);
  const remotes = git.capture(['remote']).split('\n').filter(Boolean);
  const branchPush = git.run(['config', '--get', `branch.${branch}.pushRemote`], {
    allowFailure: true,
  });
  const defaultPush = git.run(['config', '--get', 'remote.pushDefault'], { allowFailure: true });
  const branchRemote = git.run(['config', '--get', `branch.${branch}.remote`], {
    allowFailure: true,
  });
  const pushName =
    (branchPush.status === 0 && branchPush.stdout.trim()) ||
    (defaultPush.status === 0 && defaultPush.stdout.trim()) ||
    (branchRemote.status === 0 &&
      branchRemote.stdout.trim() !== '.' &&
      branchRemote.stdout.trim()) ||
    (remotes.includes('origin') ? 'origin' : base.name);
  const push = { name: pushName, url: git.capture(['remote', 'get-url', '--push', pushName]) };
  const baseRepository = resolveGitHubRepository(git, base);
  if (!baseRepository) return undefined;
  const headOverride = git.run(['config', '--get', 'gg.githubHeadRepository'], {
    allowFailure: true,
  });
  let headRepository = resolveGitHubRepository(git, push);
  if (headOverride.status === 0 && headOverride.stdout.trim()) {
    const pieces = headOverride.stdout.trim().split('/');
    if (pieces.length === 3) {
      headRepository = {
        host: pieces[0]!,
        owner: pieces[1]!,
        name: pieces[2]!,
        remote: push.name,
        pushUrl: push.url,
        baseRemote: base.name,
        headOwner: pieces[1]!,
      };
    }
  }
  if (!headRepository || headRepository.host !== baseRepository.host) return undefined;
  return {
    ...baseRepository,
    remote: push.name,
    pushUrl: push.url,
    baseRemote: base.name,
    headOwner: headRepository.owner,
  };
}

export async function authenticatedGitHubClient(
  repository: GitHubRepository,
): Promise<GitHubClient> {
  if (commandExists('gh')) {
    const client = new GhClient();
    try {
      await client.preflight(repository);
      return client;
    } catch (error) {
      if (!(error instanceof GhAuthUnavailable)) throw error;
      // Fall through to the explicit token transport only for missing gh auth.
    }
  }
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const client = new TokenClient(token);
    await client.preflight(repository);
    return client;
  }
  throw ggError(
    'GitHub authentication is required.\nRun `gh auth login --hostname github.com`, or set GITHUB_TOKEN with pull-request access.',
  );
}

class GhAuthUnavailable extends Error {}

class GhClient implements GitHubClient {
  async preflight(repository: GitHubRepository): Promise<void> {
    const result = runCommand('gh', ['auth', 'status', '--active', '--hostname', repository.host], {
      cwd: process.cwd(),
      allowFailure: true,
    });
    if (result.status !== 0) throw new GhAuthUnavailable('gh is not authenticated.');
    this.api(repository, 'GET', `repos/${repository.owner}/${repository.name}`);
  }

  async listForHead(repository: GitHubRepository, branch: string): Promise<PullRequest[]> {
    const head = encodeURIComponent(`${repository.headOwner}:${branch}`);
    const value = this.api(
      repository,
      'GET',
      `repos/${repository.owner}/${repository.name}/pulls?state=all&head=${head}&sort=updated&direction=desc&per_page=100`,
    );
    if (!Array.isArray(value)) throw ggError('GitHub returned malformed pull-request data.');
    return value.map(normalizePullRequest);
  }

  async create(repository: GitHubRepository, input: PullRequestInput): Promise<PullRequest> {
    return normalizePullRequest(
      this.api(repository, 'POST', `repos/${repository.owner}/${repository.name}/pulls`, input),
    );
  }

  async update(
    repository: GitHubRepository,
    number: number,
    input: Partial<PullRequestInput>,
  ): Promise<PullRequest> {
    return normalizePullRequest(
      this.api(
        repository,
        'PATCH',
        `repos/${repository.owner}/${repository.name}/pulls/${number}`,
        input,
      ),
    );
  }

  async publish(repository: GitHubRepository, pullRequest: PullRequest): Promise<void> {
    if (!pullRequest.draft) return;
    requireNodeId(pullRequest);
    const query = {
      query:
        'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{url}}}',
      variables: { id: pullRequest.nodeId },
    };
    this.api(repository, 'POST', 'graphql', query);
  }

  async requestReviewers(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    reviewers: string[],
    teams: string[],
  ): Promise<void> {
    if (reviewers.length === 0 && teams.length === 0) return;
    this.api(
      repository,
      'POST',
      `repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/requested_reviewers`,
      { reviewers, team_reviewers: teams },
    );
  }

  async comment(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    body: string,
  ): Promise<void> {
    this.api(
      repository,
      'POST',
      `repos/${repository.owner}/${repository.name}/issues/${pullRequest.number}/comments`,
      { body },
    );
  }

  async listComments(
    repository: GitHubRepository,
    pullRequest: PullRequest,
  ): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; ; page += 1) {
      const value = this.api(
        repository,
        'GET',
        `repos/${repository.owner}/${repository.name}/issues/${pullRequest.number}/comments?per_page=100&page=${page}`,
      );
      const batch = normalizeIssueComments(value);
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
  }

  async updateComment(
    repository: GitHubRepository,
    comment: IssueComment,
    body: string,
  ): Promise<void> {
    this.api(
      repository,
      'PATCH',
      `repos/${repository.owner}/${repository.name}/issues/comments/${comment.id}`,
      { body },
    );
  }

  async enableAutoMerge(repository: GitHubRepository, pullRequest: PullRequest): Promise<void> {
    requireNodeId(pullRequest);
    this.api(repository, 'POST', 'graphql', {
      query:
        'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{url}}}',
      variables: { id: pullRequest.nodeId },
    });
  }

  async reviewersForRerequest(
    repository: GitHubRepository,
    pullRequest: PullRequest,
  ): Promise<string[]> {
    const value = this.api(
      repository,
      'GET',
      `repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/reviews`,
    );
    return reviewAuthors(value);
  }

  private api(
    repository: GitHubRepository,
    method: string,
    endpoint: string,
    body?: unknown,
  ): unknown {
    const args = ['api', '--hostname', repository.host, '--method', method, endpoint];
    const commandOptions: {
      cwd: string;
      allowFailure: boolean;
      input?: string;
    } = {
      cwd: process.cwd(),
      allowFailure: true,
    };
    if (body !== undefined) commandOptions.input = JSON.stringify(body);
    const result = runCommand(
      'gh',
      body === undefined ? args : [...args, '--input', '-'],
      commandOptions,
    );
    if (result.status !== 0) {
      throw ggError(`GitHub request failed: ${sanitizeApiError(result.stderr || result.stdout)}`);
    }
    let parsed: any;
    try {
      parsed = result.stdout.trim() ? (JSON.parse(result.stdout) as any) : {};
    } catch {
      throw ggError('GitHub returned malformed JSON.');
    }
    if (endpoint === 'graphql' && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw ggError('GitHub GraphQL mutation failed.');
    }
    return parsed;
  }
}

class TokenClient implements GitHubClient {
  constructor(private readonly token: string) {}

  async preflight(repository: GitHubRepository): Promise<void> {
    await this.api(repository, 'GET', `repos/${repository.owner}/${repository.name}`);
  }

  async listForHead(repository: GitHubRepository, branch: string): Promise<PullRequest[]> {
    const head = encodeURIComponent(`${repository.headOwner}:${branch}`);
    const value = await this.api(
      repository,
      'GET',
      `repos/${repository.owner}/${repository.name}/pulls?state=all&head=${head}&sort=updated&direction=desc&per_page=100`,
    );
    if (!Array.isArray(value)) throw ggError('GitHub returned malformed pull-request data.');
    return value.map(normalizePullRequest);
  }

  async create(repository: GitHubRepository, input: PullRequestInput): Promise<PullRequest> {
    return normalizePullRequest(
      await this.api(
        repository,
        'POST',
        `repos/${repository.owner}/${repository.name}/pulls`,
        input,
      ),
    );
  }

  async update(
    repository: GitHubRepository,
    number: number,
    input: Partial<PullRequestInput>,
  ): Promise<PullRequest> {
    return normalizePullRequest(
      await this.api(
        repository,
        'PATCH',
        `repos/${repository.owner}/${repository.name}/pulls/${number}`,
        input,
      ),
    );
  }

  async publish(repository: GitHubRepository, pullRequest: PullRequest): Promise<void> {
    if (!pullRequest.draft) return;
    requireNodeId(pullRequest);
    await this.api(repository, 'POST', 'graphql', {
      query:
        'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{url}}}',
      variables: { id: pullRequest.nodeId },
    });
  }

  async requestReviewers(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    reviewers: string[],
    teams: string[],
  ): Promise<void> {
    if (reviewers.length === 0 && teams.length === 0) return;
    await this.api(
      repository,
      'POST',
      `repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/requested_reviewers`,
      { reviewers, team_reviewers: teams },
    );
  }

  async comment(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    body: string,
  ): Promise<void> {
    await this.api(
      repository,
      'POST',
      `repos/${repository.owner}/${repository.name}/issues/${pullRequest.number}/comments`,
      { body },
    );
  }

  async listComments(
    repository: GitHubRepository,
    pullRequest: PullRequest,
  ): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; ; page += 1) {
      const value = await this.api(
        repository,
        'GET',
        `repos/${repository.owner}/${repository.name}/issues/${pullRequest.number}/comments?per_page=100&page=${page}`,
      );
      const batch = normalizeIssueComments(value);
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
  }

  async updateComment(
    repository: GitHubRepository,
    comment: IssueComment,
    body: string,
  ): Promise<void> {
    await this.api(
      repository,
      'PATCH',
      `repos/${repository.owner}/${repository.name}/issues/comments/${comment.id}`,
      { body },
    );
  }

  async enableAutoMerge(repository: GitHubRepository, pullRequest: PullRequest): Promise<void> {
    requireNodeId(pullRequest);
    await this.api(repository, 'POST', 'graphql', {
      query:
        'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{url}}}',
      variables: { id: pullRequest.nodeId },
    });
  }

  async reviewersForRerequest(
    repository: GitHubRepository,
    pullRequest: PullRequest,
  ): Promise<string[]> {
    const value = await this.api(
      repository,
      'GET',
      `repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/reviews`,
    );
    return reviewAuthors(value);
  }

  private async api(
    repository: GitHubRepository,
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    const apiBase =
      repository.host === 'github.com'
        ? 'https://api.github.com'
        : `https://${repository.host}/api/v3`;
    const requestUrl =
      endpoint === 'graphql' && repository.host !== 'github.com'
        ? `https://${repository.host}/api/graphql`
        : `${apiBase}/${endpoint}`;
    let response: Response;
    try {
      const request: RequestInit = {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      };
      if (body !== undefined) request.body = JSON.stringify(body);
      response = await fetch(requestUrl, request);
    } catch {
      throw ggError('Could not connect to GitHub.');
    }
    const text = await response.text();
    if (!response.ok) throw ggError(`GitHub request failed (${response.status}).`);
    let parsed: any;
    try {
      parsed = text ? (JSON.parse(text) as any) : {};
    } catch {
      throw ggError('GitHub returned malformed JSON.');
    }
    if (endpoint === 'graphql' && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw ggError('GitHub GraphQL mutation failed.');
    }
    return parsed;
  }
}

function normalizePullRequest(value: any): PullRequest {
  const merged = Boolean(value.merged_at);
  const state = merged
    ? 'MERGED'
    : String(value.state ?? '').toUpperCase() === 'OPEN'
      ? 'OPEN'
      : 'CLOSED';
  return {
    number: Number(value.number),
    nodeId: String(value.node_id ?? value.nodeId ?? ''),
    url: String(value.html_url ?? value.url ?? ''),
    state,
    draft: Boolean(value.draft),
    headRef: String(value.head?.ref ?? value.headRefName ?? ''),
    baseRef: String(value.base?.ref ?? value.baseRefName ?? ''),
    title: String(value.title ?? ''),
    body: String(value.body ?? ''),
    requestedReviewers: Array.isArray(value.requested_reviewers)
      ? value.requested_reviewers.map((reviewer: any) => String(reviewer.login)).filter(Boolean)
      : [],
    requestedTeams: Array.isArray(value.requested_teams)
      ? value.requested_teams.map((team: any) => String(team.slug)).filter(Boolean)
      : [],
  };
}

function normalizeIssueComments(value: unknown): IssueComment[] {
  if (!Array.isArray(value)) throw ggError('GitHub returned malformed issue-comment data.');
  return value.map((comment: any) => ({
    id: Number(comment.id),
    body: String(comment.body ?? ''),
  }));
}

function normalizeHost(host: string): string {
  if (host === 'github-personal') return 'github.com';
  return host.toLowerCase();
}

function stripDotGit(value: string): string {
  return value.replace(/\.git$/, '');
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function sanitizeApiError(value: string): string {
  const line = value.trim().split('\n')[0] ?? 'unknown error';
  return line.replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/g, '[redacted]');
}

function requireNodeId(pullRequest: PullRequest): void {
  if (!pullRequest.nodeId) {
    throw ggError(`GitHub did not return a node ID for PR #${pullRequest.number}.`);
  }
}

function reviewAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) throw ggError('GitHub returned malformed review data.');
  return [
    ...new Set(
      value
        .map((review: any) => String(review.user?.login ?? ''))
        .filter((login) => login && !login.endsWith('[bot]')),
    ),
  ];
}
