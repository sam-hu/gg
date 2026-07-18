#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.GG_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write('GG_FAKE_GH_STATE is required\n');
  process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, 'utf8'));
state.calls ??= [];
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('gh version 2.96.0\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(state.auth === false ? 1 : 0);
}
if (args[0] !== 'api') {
  process.stderr.write(`unsupported fake gh command: ${args.join(' ')}\n`);
  process.exit(2);
}

const methodIndex = args.indexOf('--method');
const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';
const endpoint = args.find(
  (arg, index) =>
    index > 0 &&
    !arg.startsWith('-') &&
    args[index - 1] !== '--hostname' &&
    args[index - 1] !== '--method',
);
let body;
if (args.includes('--input')) {
  const input = readFileSync(0, 'utf8');
  body = input ? JSON.parse(input) : undefined;
}
const jqIndex = args.indexOf('--jq');
const jq = jqIndex >= 0 ? args[jqIndex + 1] : undefined;
state.calls.push({ method, endpoint, body, jq });

let output = {};
if (method === 'GET' && /^repos\/[^/]+\/[^/?]+$/.test(endpoint ?? '')) {
  output = { full_name: 'owner/repo' };
} else if (method === 'GET' && endpoint?.includes('/pulls?')) {
  const url = new URL(`https://fake.invalid/${endpoint}`);
  const head = url.searchParams.get('head')?.split(':').slice(1).join(':');
  output = head ? (state.prs ?? []).filter((pr) => pr.head.ref === head) : (state.prs ?? []);
  if (jq !== undefined) output = output.map(projectPullRequest);
} else if (method === 'GET' && endpoint?.endsWith('/reviews')) {
  output = state.reviews ?? [];
} else if (method === 'GET' && endpoint?.includes('/issues/') && endpoint.includes('/comments?')) {
  const number = Number(endpoint.split('/issues/')[1].split('/')[0]);
  output = (state.comments ?? []).filter((comment) => comment.pullRequestNumber === number);
} else if (method === 'POST' && endpoint?.endsWith('/pulls')) {
  const number = state.nextNumber ?? 101;
  state.nextNumber = number + 1;
  const pr = {
    number,
    node_id: `PR_fake_${number}`,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: 'open',
    draft: Boolean(body.draft),
    title: body.title,
    body: body.body,
    head: { ref: String(body.head).split(':').slice(1).join(':') },
    base: { ref: body.base },
    requested_reviewers: [],
    requested_teams: [],
  };
  state.prs ??= [];
  state.prs.push(pr);
  output = pr;
} else if (method === 'PATCH' && endpoint?.includes('/pulls/')) {
  const number = Number(endpoint.split('/').at(-1));
  const pr = state.prs.find((candidate) => candidate.number === number);
  if (!pr) process.exit(1);
  if (body.base !== undefined) pr.base.ref = body.base;
  if (body.title !== undefined) pr.title = body.title;
  if (body.body !== undefined) pr.body = body.body;
  output = pr;
} else if (method === 'POST' && endpoint?.endsWith('/requested_reviewers')) {
  const number = Number(endpoint.split('/').at(-2));
  const pr = state.prs.find((candidate) => candidate.number === number);
  if (!pr) process.exit(1);
  pr.requested_reviewers = (body.reviewers ?? []).map((login) => ({ login }));
  pr.requested_teams = (body.team_reviewers ?? []).map((slug) => ({ slug }));
  output = pr;
} else if (method === 'POST' && endpoint?.includes('/issues/') && endpoint.endsWith('/comments')) {
  state.comments ??= [];
  const number = Number(endpoint.split('/issues/')[1].split('/')[0]);
  const comment = {
    id: state.nextCommentId ?? 1,
    pullRequestNumber: number,
    endpoint,
    body: body.body,
  };
  state.nextCommentId = comment.id + 1;
  state.comments.push(comment);
  output = comment;
} else if (method === 'PATCH' && endpoint?.includes('/issues/comments/')) {
  const id = Number(endpoint.split('/').at(-1));
  const comment = state.comments?.find((candidate) => candidate.id === id);
  if (!comment) process.exit(1);
  comment.body = body.body;
  output = comment;
} else if (method === 'PUT' && endpoint?.endsWith('/merge')) {
  const number = Number(endpoint.split('/').at(-2));
  const pr = state.prs?.find((candidate) => candidate.number === number);
  if (!pr) process.exit(1);
  if (state.mergeError) {
    output = { merged: false, message: state.mergeError };
  } else {
    const sha = state.mergeSha;
    if (!sha) {
      process.stderr.write('mergeSha is required for fake PR merges\n');
      process.exit(2);
    }
    if (state.mergeRemote) {
      const update = spawnSync(
        'git',
        ['--git-dir', state.mergeRemote, 'update-ref', 'refs/heads/main', sha],
        { encoding: 'utf8' },
      );
      if (update.status !== 0) {
        process.stderr.write(update.stderr || update.stdout || 'failed to update fake remote\n');
        process.exit(update.status ?? 2);
      }
    }
    pr.state = 'closed';
    pr.merged_at = '2026-07-17T00:00:00Z';
    output = { merged: true, sha };
  }
} else if (endpoint === 'graphql') {
  if (body?.query?.includes('comments(first:100')) {
    const repository = {};
    for (const match of body.query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) {
      const number = Number(match[2]);
      repository[match[1]] = {
        comments: {
          nodes: (state.comments ?? [])
            .filter((comment) => comment.pullRequestNumber === number)
            .map((comment) => ({ databaseId: comment.id, body: comment.body })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    output = { data: { repository } };
  } else {
    const valid = (state.prs ?? []).some((pr) => pr.node_id === body?.variables?.id);
    output = valid ? { data: {} } : { errors: [{ message: 'invalid node id' }] };
  }
} else {
  process.stderr.write(`unsupported fake gh API call: ${method} ${endpoint}\n`);
  process.exit(2);
}

writeFileSync(statePath, JSON.stringify(state, null, 2));
process.stdout.write(JSON.stringify(output));

function projectPullRequest(pr) {
  return {
    number: pr.number,
    node_id: pr.node_id,
    html_url: pr.html_url,
    state: pr.state,
    merged_at: pr.merged_at,
    draft: pr.draft,
    title: pr.title,
    body: pr.body,
    head: {
      ref: pr.head?.ref,
      sha: pr.head?.sha,
      repo: { owner: { login: pr.head?.repo?.owner?.login } },
    },
    base: { ref: pr.base?.ref },
    requested_reviewers: (pr.requested_reviewers ?? []).map(({ login }) => ({ login })),
    requested_teams: (pr.requested_teams ?? []).map(({ slug }) => ({ slug })),
  };
}
