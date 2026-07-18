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
  headOwner: string;
  headSha: string;
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
  pullRequestNumber: number;
}

export interface MergeResult {
  sha: string;
}

export interface GitHubClient {
  preflight(repository: GitHubRepository): Promise<void>;
  listPullRequests(repository: GitHubRepository): Promise<PullRequest[]>;
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
  listComments(repository: GitHubRepository, pullRequests: PullRequest[]): Promise<IssueComment[]>;
  comment(repository: GitHubRepository, pullRequest: PullRequest, body: string): Promise<void>;
  updateComment(repository: GitHubRepository, comment: IssueComment, body: string): Promise<void>;
  merge(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    expectedHead: string,
  ): Promise<MergeResult>;
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
  return new SubmissionRepositoryResolver(git, trunk).resolve(branch);
}

export class SubmissionRepositoryResolver {
  private readonly config: Map<string, string>;
  private readonly remotes: string[];
  private readonly base: { name: string; url: string };
  private readonly baseRepository: GitHubRepository | undefined;
  private readonly pushUrls = new Map<string, string>();

  constructor(
    private readonly git: Git,
    trunk: string,
  ) {
    this.config = readGitConfig(git);
    this.remotes = git.capture(['remote']).split('\n').filter(Boolean);
    const configured = this.config.get(`branch.${trunk}.remote`);
    const name =
      configured && configured !== '.'
        ? configured
        : this.remotes.includes('origin')
          ? 'origin'
          : this.remotes.length === 1
            ? this.remotes[0]!
            : undefined;
    if (!name) throw ggError('Could not determine which Git remote to use.');
    this.base = { name, url: git.capture(['remote', 'get-url', name]) };
    this.baseRepository = repositoryFromOverride(this.config.get('gg.githubrepository'), this.base);
  }

  resolve(branch: string): GitHubRepository | undefined {
    if (!this.baseRepository) return undefined;
    const branchRemote = this.config.get(`branch.${branch}.remote`);
    const pushName =
      this.config.get(`branch.${branch}.pushremote`) ??
      this.config.get('remote.pushdefault') ??
      (branchRemote && branchRemote !== '.' ? branchRemote : undefined) ??
      (this.remotes.includes('origin') ? 'origin' : this.base.name);
    let pushUrl = this.pushUrls.get(pushName);
    if (!pushUrl) {
      pushUrl = this.git.capture(['remote', 'get-url', '--push', pushName]);
      this.pushUrls.set(pushName, pushUrl);
    }
    const push = { name: pushName, url: pushUrl };
    const headRepository = repositoryFromOverride(
      this.config.get('gg.githubheadrepository') ?? this.config.get('gg.githubrepository'),
      push,
    );
    if (!headRepository || headRepository.host !== this.baseRepository.host) return undefined;
    return {
      ...this.baseRepository,
      remote: pushName,
      pushUrl,
      baseRemote: this.base.name,
      headOwner: headRepository.owner,
    };
  }
}

function readGitConfig(git: Git): Map<string, string> {
  const output = git.run(['config', '--null', '--list']).stdout;
  const config = new Map<string, string>();
  for (const entry of output.split('\0')) {
    const separator = entry.indexOf('\n');
    if (separator < 0) continue;
    config.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return config;
}

function repositoryFromOverride(
  override: string | undefined,
  remote: { name: string; url: string },
): GitHubRepository | undefined {
  if (override) {
    const pieces = override.split('/');
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

export async function authenticatedGitHubClient(
  repository: GitHubRepository,
): Promise<GitHubClient> {
  if (commandExists('gh')) {
    try {
      GhTransport.requireAuthentication(repository);
      const client = new GitHubOperations(new GhTransport());
      await client.preflight(repository);
      return client;
    } catch (error) {
      if (!(error instanceof GhAuthUnavailable)) throw error;
      // Fall through to the explicit token transport only for missing gh auth.
    }
  }
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const client = new GitHubOperations(new TokenTransport(token));
    await client.preflight(repository);
    return client;
  }
  throw ggError(
    'GitHub authentication is required.\nRun `gh auth login --hostname github.com`, or set GITHUB_TOKEN with pull-request access.',
  );
}

class GhAuthUnavailable extends Error {}

interface GitHubTransport {
  request(
    repository: GitHubRepository,
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<unknown>;
}

class GitHubOperations implements GitHubClient {
  constructor(private readonly transport: GitHubTransport) {}

  async preflight(repository: GitHubRepository): Promise<void> {
    await this.transport.request(repository, 'GET', `repos/${repository.owner}/${repository.name}`);
  }

  async listPullRequests(repository: GitHubRepository): Promise<PullRequest[]> {
    const pullRequests: PullRequest[] = [];
    for (let page = 1; ; page += 1) {
      const value = await this.transport.request(
        repository,
        'GET',
        `repos/${repository.owner}/${repository.name}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      if (!Array.isArray(value)) throw ggError('GitHub returned malformed pull-request data.');
      const batch = value.map(normalizePullRequest);
      pullRequests.push(...batch);
      if (batch.length < 100) return pullRequests;
    }
  }

  async listForHead(repository: GitHubRepository, branch: string): Promise<PullRequest[]> {
    return (await this.listPullRequests(repository)).filter((pullRequest) =>
      matchesHead(repository, pullRequest, branch),
    );
  }

  async create(repository: GitHubRepository, input: PullRequestInput): Promise<PullRequest> {
    return normalizePullRequest(
      await this.transport.request(
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
      await this.transport.request(
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
    await this.transport.request(repository, 'POST', 'graphql', query);
  }

  async requestReviewers(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    reviewers: string[],
    teams: string[],
  ): Promise<void> {
    if (reviewers.length === 0 && teams.length === 0) return;
    await this.transport.request(
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
    await this.transport.request(
      repository,
      'POST',
      `repos/${repository.owner}/${repository.name}/issues/${pullRequest.number}/comments`,
      { body },
    );
  }

  async listComments(
    repository: GitHubRepository,
    pullRequests: PullRequest[],
  ): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    let pending = [...new Set(pullRequests.map(({ number }) => number))].map((number) => ({
      number,
      cursor: undefined as string | undefined,
    }));
    while (pending.length > 0) {
      const query = issueCommentsQuery(repository, pending);
      const pages = normalizeIssueCommentPages(
        await this.transport.request(repository, 'POST', 'graphql', query),
        pending,
      );
      comments.push(...pages.comments);
      pending = pages.pending;
    }
    return comments;
  }

  async updateComment(
    repository: GitHubRepository,
    comment: IssueComment,
    body: string,
  ): Promise<void> {
    await this.transport.request(
      repository,
      'PATCH',
      `repos/${repository.owner}/${repository.name}/issues/comments/${comment.id}`,
      { body },
    );
  }

  async enableAutoMerge(repository: GitHubRepository, pullRequest: PullRequest): Promise<void> {
    requireNodeId(pullRequest);
    await this.transport.request(repository, 'POST', 'graphql', {
      query:
        'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{url}}}',
      variables: { id: pullRequest.nodeId },
    });
  }

  async merge(
    repository: GitHubRepository,
    pullRequest: PullRequest,
    expectedHead: string,
  ): Promise<MergeResult> {
    return normalizeMergeResult(
      await this.transport.request(
        repository,
        'PUT',
        `repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/merge`,
        { merge_method: 'squash', sha: expectedHead },
      ),
      pullRequest,
    );
  }

  async reviewersForRerequest(
    repository: GitHubRepository,
    pullRequest: PullRequest,
  ): Promise<string[]> {
    const value = await this.transport.request(
      repository,
      'GET',
      `repos/${repository.owner}/${repository.name}/pulls/${pullRequest.number}/reviews`,
    );
    return reviewAuthors(value);
  }
}

class GhTransport implements GitHubTransport {
  static requireAuthentication(repository: GitHubRepository): void {
    const result = runCommand('gh', ['auth', 'status', '--active', '--hostname', repository.host], {
      cwd: process.cwd(),
      allowFailure: true,
    });
    if (result.status !== 0) throw new GhAuthUnavailable('gh is not authenticated.');
  }

  async request(
    repository: GitHubRepository,
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
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
    return parseApiResponse(result.stdout, endpoint);
  }
}

class TokenTransport implements GitHubTransport {
  constructor(private readonly token: string) {}

  async request(
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
    return parseApiResponse(text, endpoint);
  }
}

function parseApiResponse(text: string, endpoint: string): unknown {
  let parsed: any;
  try {
    parsed = text.trim() ? (JSON.parse(text) as any) : {};
  } catch {
    throw ggError('GitHub returned malformed JSON.');
  }
  if (endpoint === 'graphql' && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw ggError('GitHub GraphQL mutation failed.');
  }
  return parsed;
}

function normalizePullRequest(value: any): PullRequest {
  const merged = Boolean(value.merged_at);
  const rawState = String(value.state ?? '').toUpperCase();
  let state: PullRequest['state'];
  if (merged) state = 'MERGED';
  else if (rawState === 'OPEN' || rawState === 'CLOSED') state = rawState;
  else throw ggError(`GitHub returned unknown pull-request state: ${rawState || '(missing)'}.`);
  return {
    number: Number(value.number),
    nodeId: String(value.node_id ?? value.nodeId ?? ''),
    url: String(value.html_url ?? value.url ?? ''),
    state,
    draft: Boolean(value.draft),
    headRef: String(value.head?.ref ?? value.headRefName ?? ''),
    headOwner: String(
      value.head?.repo?.owner?.login ??
        value.headOwner ??
        String(value.head?.label ?? '').split(':')[0],
    ),
    headSha: String(value.head?.sha ?? value.headSha ?? ''),
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

interface PendingCommentPage {
  number: number;
  cursor: string | undefined;
}

function issueCommentsQuery(
  repository: GitHubRepository,
  pending: PendingCommentPage[],
): { query: string; variables: Record<string, string | null> } {
  const cursorDefinitions = pending.map((_, index) => `$cursor${index}:String`).join(',');
  const fields = pending
    .map(
      ({ number }, index) =>
        `p${index}:pullRequest(number:${number}){comments(first:100,after:$cursor${index}){nodes{databaseId body}pageInfo{hasNextPage endCursor}}}`,
    )
    .join('');
  return {
    query: `query($owner:String!,$name:String!,${cursorDefinitions}){repository(owner:$owner,name:$name){${fields}}}`,
    variables: Object.fromEntries([
      ['owner', repository.owner],
      ['name', repository.name],
      ...pending.map(({ cursor }, index) => [`cursor${index}`, cursor ?? null] as const),
    ]),
  };
}

function normalizeIssueCommentPages(
  value: any,
  requested: PendingCommentPage[],
): { comments: IssueComment[]; pending: PendingCommentPage[] } {
  const repository = value?.data?.repository;
  if (!repository || typeof repository !== 'object') {
    throw ggError('GitHub returned malformed issue-comment data.');
  }
  const comments: IssueComment[] = [];
  const pending: PendingCommentPage[] = [];
  for (const [index, request] of requested.entries()) {
    const connection = repository[`p${index}`]?.comments;
    if (!connection || !Array.isArray(connection.nodes)) continue;
    for (const comment of connection.nodes) {
      comments.push({
        id: Number(comment.databaseId),
        body: String(comment.body ?? ''),
        pullRequestNumber: request.number,
      });
    }
    if (connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor) {
      pending.push({ number: request.number, cursor: String(connection.pageInfo.endCursor) });
    }
  }
  return { comments, pending };
}

function matchesHead(
  repository: GitHubRepository,
  pullRequest: PullRequest,
  branch: string,
): boolean {
  return (
    pullRequest.headRef === branch &&
    (!pullRequest.headOwner || pullRequest.headOwner === repository.headOwner)
  );
}

function normalizeMergeResult(value: any, pullRequest: PullRequest): MergeResult {
  if (!value || value.merged !== true) {
    const detail = typeof value?.message === 'string' ? `: ${value.message}` : '';
    throw ggError(`GitHub could not merge PR #${pullRequest.number}${detail}`);
  }
  const sha = String(value.sha ?? '');
  if (!sha) throw ggError(`GitHub did not return a merge commit for PR #${pullRequest.number}.`);
  return { sha };
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
