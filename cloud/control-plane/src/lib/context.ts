import type { User, Session, Repo } from '../db/schema';
import type { Repository } from '../db/repository';
import type { RedisPublisher } from '../events/pipeline';
import type { SSEBroadcaster } from '../events/broadcaster';
import type { RateLimitStore } from '../middleware/rate-limit';

export type VerifyTokenFn = (token: string) => Promise<{ clerkId: string }>;

export type GithubRepoSummary = {
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type GithubClient = {
  reposGet: (
    owner: string,
    repo: string,
  ) => Promise<{ defaultBranch: string; language?: string | null }>;
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
  getRepoTree: (
    owner: string,
    repo: string,
    ref: string,
  ) => Promise<Array<{ path: string; type: 'blob' | 'tree' | 'commit'; size?: number }>>;
  getFileContent: (
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ) => Promise<string | null>;
};

export type GithubClientFactory = (
  accessToken: string | null | undefined,
) => GithubClient;

export type StripeClient = {
  createCustomer: (input: {
    email?: string;
    metadata?: Record<string, string>;
  }) => Promise<{ id: string }>;
  reportUsage: (input: {
    subscriptionItemId: string;
    quantity: number;
    idempotencyKey: string;
  }) => Promise<void>;
  createCheckoutSession: (input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }) => Promise<{ url: string }>;
  createPortalSession: (input: {
    customerId: string;
    returnUrl: string;
  }) => Promise<{ url: string }>;
  parseWebhook: (
    rawBody: string,
    signature: string,
  ) => Promise<{ type: string; data: Record<string, unknown> }>;
};

export type AppDeps = {
  repo: Repository;
  sessionRuntime?: {
    apiKeyForModel: (model: string) => string | undefined;
    start: (session: Session, repo: Repo, user: User, apiKey: string) => Promise<void>;
  };
  verifyToken: VerifyTokenFn;
  githubClient: GithubClientFactory;
  stripe: StripeClient | null;
  billing: BillingConfig;
  rateLimit: RateLimitStore;
  redis: RedisPublisher;
  broadcaster: SSEBroadcaster;
};

export type BillingConfig = {
  freeMinutesPerMonth: number;
  usageSubscriptionItemPerUser: Map<string, string>;
  priceIds: Record<'pro' | 'team', string>;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
};

export type AppEnv = {
  Variables: {
    user: User;
    requestId: string;
    deps: AppDeps;
  };
};
