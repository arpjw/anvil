import type { User } from '../db/schema';
import type { Repository } from '../db/repository';
import type { RedisPublisher } from '../events/pipeline';
import type { SSEBroadcaster } from '../events/broadcaster';

export type VerifyTokenFn = (token: string) => Promise<{ clerkId: string }>;

export type GithubRepoSummary = {
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type GithubClient = {
  reposGet: (owner: string, repo: string) => Promise<{ defaultBranch: string }>;
  reposListBranches: (
    owner: string,
    repo: string,
  ) => Promise<Array<{ name: string; commit: { sha: string } }>>;
  listUserRepos: () => Promise<GithubRepoSummary[]>;
  getBranchSha: (
    owner: string,
    repo: string,
    branch: string,
  ) => Promise<string>;
  createBranch: (
    owner: string,
    repo: string,
    branch: string,
    fromSha: string,
  ) => Promise<void>;
  getFileSha: (
    owner: string,
    repo: string,
    path: string,
    branch: string,
  ) => Promise<string | null>;
  putFile: (
    owner: string,
    repo: string,
    args: {
      path: string;
      branch: string;
      message: string;
      content: string;
      sha?: string | null;
    },
  ) => Promise<void>;
  createPullRequest: (
    owner: string,
    repo: string,
    args: { title: string; body: string; head: string; base: string },
  ) => Promise<{ url: string; number: number }>;
};

export type GithubClientFactory = (
  accessToken: string | null | undefined,
) => GithubClient;

export type AppDeps = {
  repo: Repository;
  verifyToken: VerifyTokenFn;
  githubClient: GithubClientFactory;
  redis: RedisPublisher;
  broadcaster: SSEBroadcaster;
};

export type AppEnv = {
  Variables: {
    user: User;
    requestId: string;
    deps: AppDeps;
  };
};
