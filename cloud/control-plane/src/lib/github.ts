import { Octokit } from '@octokit/rest';
import type { GithubClient, GithubClientFactory } from './context';
import { HttpError } from './errors';

function toBase64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

function throwNotAccessible(err: unknown): never {
  const status = statusOf(err);
  if (status === 404 || status === 403) {
    throw new HttpError(404, 'repo_not_found', 'repo not accessible');
  }
  throw err;
}

export const octokitGithubClient: GithubClientFactory = (accessToken) => {
  const client = new Octokit({ auth: accessToken ?? undefined });
  const wrapped: GithubClient = {
    async reposGet(owner, repo) {
      try {
        const { data } = await client.repos.get({ owner, repo });
        return { defaultBranch: data.default_branch };
      } catch (err) {
        throwNotAccessible(err);
      }
    },
    async reposListBranches(owner, repo) {
      try {
        const { data } = await client.repos.listBranches({
          owner,
          repo,
          per_page: 100,
        });
        return data.map((branch) => ({
          name: branch.name,
          commit: { sha: branch.commit.sha },
        }));
      } catch (err) {
        throwNotAccessible(err);
      }
    },
    async listUserRepos() {
      try {
        const { data } = await client.repos.listForAuthenticatedUser({
          per_page: 100,
          sort: 'pushed',
          affiliation: 'owner,collaborator,organization_member',
        });
        return data.map((r) => ({
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          private: r.private,
        }));
      } catch (err) {
        throwNotAccessible(err);
      }
    },
    async getBranchSha(owner, repo, branch) {
      try {
        const { data } = await client.git.getRef({
          owner,
          repo,
          ref: `heads/${branch}`,
        });
        return data.object.sha;
      } catch (err) {
        throwNotAccessible(err);
      }
    },
    async createBranch(owner, repo, branch, fromSha) {
      try {
        await client.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: fromSha,
        });
      } catch (err) {
        const status = statusOf(err);
        if (status === 422) {
          throw new HttpError(
            409,
            'branch_exists',
            `branch ${branch} already exists`,
          );
        }
        throwNotAccessible(err);
      }
    },
    async getFileSha(owner, repo, path, branch) {
      try {
        const { data } = await client.repos.getContent({
          owner,
          repo,
          path,
          ref: branch,
        });
        if (Array.isArray(data)) return null;
        if ('sha' in data) return data.sha;
        return null;
      } catch (err) {
        const status = statusOf(err);
        if (status === 404) return null;
        throwNotAccessible(err);
      }
    },
    async putFile(owner, repo, args) {
      try {
        await client.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: args.path,
          message: args.message,
          content: toBase64(args.content),
          branch: args.branch,
          ...(args.sha ? { sha: args.sha } : {}),
        });
      } catch (err) {
        throwNotAccessible(err);
      }
    },
    async createPullRequest(owner, repo, args) {
      try {
        const { data } = await client.pulls.create({
          owner,
          repo,
          title: args.title,
          body: args.body,
          head: args.head,
          base: args.base,
        });
        return { url: data.html_url, number: data.number };
      } catch (err) {
        throwNotAccessible(err);
      }
    },
  };
  return wrapped;
};
