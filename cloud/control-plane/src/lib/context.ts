import type { User } from '../db/schema';
import type { Repository } from '../db/repository';

export type VerifyTokenFn = (token: string) => Promise<{ clerkId: string }>;

export type GithubClient = {
  reposGet: (owner: string, repo: string) => Promise<{ defaultBranch: string }>;
  reposListBranches: (
    owner: string,
    repo: string,
  ) => Promise<Array<{ name: string; commit: { sha: string } }>>;
};

export type GithubClientFactory = (
  accessToken: string | null | undefined,
) => GithubClient;

export type AppDeps = {
  repo: Repository;
  verifyToken: VerifyTokenFn;
  githubClient: GithubClientFactory;
};

export type AppEnv = {
  Variables: {
    user: User;
    requestId: string;
    deps: AppDeps;
  };
};
