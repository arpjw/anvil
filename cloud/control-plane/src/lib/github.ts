import { Octokit } from '@octokit/rest';
import type { GithubClient, GithubClientFactory } from './context';
import { HttpError } from './errors';

export const octokitGithubClient: GithubClientFactory = (accessToken) => {
  const client = new Octokit({ auth: accessToken ?? undefined });
  const wrapped: GithubClient = {
    async reposGet(owner, repo) {
      try {
        const { data } = await client.repos.get({ owner, repo });
        return { defaultBranch: data.default_branch };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 403) {
          throw new HttpError(404, 'repo_not_found', 'repo not accessible');
        }
        throw err;
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
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 403) {
          throw new HttpError(404, 'repo_not_found', 'repo not accessible');
        }
        throw err;
      }
    },
  };
  return wrapped;
};
