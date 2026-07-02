import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  diffs,
  events,
  repoEmbeddings,
  repos,
  sessions,
  usageRecords,
  users,
  waitlistSignups,
  type Diff,
  type DiffStatus,
  type Event,
  type NewSession,
  type PlanTier,
  type PrState,
  type Repo,
  type RepoEmbedding,
  type Session,
  type SessionStatus,
  type UsageRecord,
  type User,
} from './schema';
import * as schema from './schema';

export type SessionWithRepoName = Session & { repoFullName: string };

export type SessionDetail = Session & {
  repoFullName: string;
  events: Event[];
  diffs: Diff[];
};

export interface Repository {
  findUserByClerkId(clerkId: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(input: { clerkId: string }): Promise<User>;
  setUserGithub(
    userId: string,
    fields: { githubLogin: string; githubAccessToken: string },
  ): Promise<User>;
  countReposByUser(userId: string): Promise<number>;

  listReposByUser(userId: string): Promise<Repo[]>;
  findRepoById(id: string): Promise<Repo | null>;
  createRepo(input: {
    userId: string;
    fullName: string;
    defaultBranch: string;
  }): Promise<Repo>;
  deleteRepo(id: string): Promise<void>;
  setRepoGeneratedRules(id: string, generatedRules: string): Promise<Repo>;

  listSessionsByUser(
    userId: string,
    opts?: { status?: SessionStatus },
  ): Promise<SessionWithRepoName[]>;
  findSessionById(id: string): Promise<SessionDetail | null>;
  createSession(input: NewSession): Promise<Session>;
  updateSessionStatus(id: string, status: SessionStatus): Promise<Session>;
  updateSessionVm(
    id: string,
    fields: { vmIp: string | null; vmPort: number | null },
  ): Promise<Session>;
  updateSessionPrUrl(id: string, prUrl: string): Promise<Session>;
  updateSessionPrState(id: string, prState: PrState): Promise<Session>;
  findSessionByPrUrl(prUrl: string): Promise<Session | null>;
  checkpointSession(
    id: string,
    fields: { phase: string; state: unknown },
  ): Promise<Session>;
  getSessionCheckpoint(
    id: string,
  ): Promise<{ phase: string; state: unknown } | null>;
  clearSessionCheckpoint(id: string): Promise<Session>;
  completeSession(
    id: string,
    fields: { completedAt: Date; durationSeconds: number },
  ): Promise<Session>;
  createEvent(
    sessionId: string,
    type: string,
    payload: unknown,
  ): Promise<Event>;
  getRecentEvents(sessionId: string, limit: number): Promise<Event[]>;

  setUserStripeCustomer(userId: string, customerId: string): Promise<User>;
  setUserSubscription(
    userId: string,
    fields: { subscriptionId: string; planTier: PlanTier },
  ): Promise<User>;
  createUsageRecord(input: {
    userId: string;
    sessionId: string;
    minutes: number;
  }): Promise<UsageRecord>;
  markUsageReported(id: string): Promise<UsageRecord>;
  listUnreportedUsage(userId: string): Promise<UsageRecord[]>;
  listUsageBySince(userId: string, since: Date): Promise<UsageRecord[]>;

  addWaitlistSignup(email: string, source: string | null): Promise<boolean>;
  countWaitlistSignups(): Promise<number>;

  getRepoEmbedding(repoId: string): Promise<RepoEmbedding | null>;
  upsertRepoEmbedding(
    repoId: string,
    data: {
      indexVersion: string;
      chunkCount: number;
      status: 'pending' | 'indexing' | 'ready' | 'failed';
      errorMessage?: string | null;
      storagePath?: string | null;
      indexedAt?: Date | null;
    },
  ): Promise<RepoEmbedding>;

  listDiffsBySession(sessionId: string): Promise<Diff[]>;
  findDiffById(id: string): Promise<Diff | null>;
  updateDiffStatus(id: string, status: DiffStatus): Promise<Diff>;
  approveAllPendingDiffs(sessionId: string): Promise<number>;
  createDiff(input: {
    sessionId: string;
    filepath: string;
    originalContent: string | null;
    newContent: string | null;
  }): Promise<Diff>;
}

export function createPgRepository(
  db: PostgresJsDatabase<typeof schema>,
): Repository {
  return {
    async findUserByClerkId(clerkId) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findUserById(id) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async createUser({ clerkId }) {
      const [row] = await db.insert(users).values({ clerkId }).returning();
      if (!row) throw new Error('failed to create user');
      return row;
    },

    async setUserGithub(userId, fields) {
      const [row] = await db
        .update(users)
        .set({
          githubLogin: fields.githubLogin,
          githubAccessToken: fields.githubAccessToken,
        })
        .where(eq(users.id, userId))
        .returning();
      if (!row) throw new Error('user not found');
      return row;
    },

    async countReposByUser(userId) {
      const rows = await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.userId, userId));
      return rows.length;
    },

    async listReposByUser(userId) {
      return db
        .select()
        .from(repos)
        .where(eq(repos.userId, userId))
        .orderBy(desc(repos.installedAt));
    },

    async findRepoById(id) {
      const rows = await db
        .select()
        .from(repos)
        .where(eq(repos.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async createRepo(input) {
      const [row] = await db
        .insert(repos)
        .values({
          userId: input.userId,
          fullName: input.fullName,
          defaultBranch: input.defaultBranch,
        })
        .returning();
      if (!row) throw new Error('failed to create repo');
      return row;
    },

    async deleteRepo(id) {
      await db.delete(repos).where(eq(repos.id, id));
    },

    async setRepoGeneratedRules(id, generatedRules) {
      const [row] = await db
        .update(repos)
        .set({ generatedRules, analyzedAt: new Date() })
        .where(eq(repos.id, id))
        .returning();
      if (!row) throw new Error('repo not found');
      return row;
    },

    async listSessionsByUser(userId, opts) {
      const conditions = [eq(sessions.userId, userId)];
      if (opts?.status) conditions.push(eq(sessions.status, opts.status));
      const rows = await db
        .select({
          id: sessions.id,
          userId: sessions.userId,
          repoId: sessions.repoId,
          status: sessions.status,
          branch: sessions.branch,
          request: sessions.request,
          model: sessions.model,
          planJson: sessions.planJson,
          vmIp: sessions.vmIp,
          vmPort: sessions.vmPort,
          prUrl: sessions.prUrl,
          prState: sessions.prState,
          checkpointPhase: sessions.checkpointPhase,
          checkpointState: sessions.checkpointState,
          startedAt: sessions.startedAt,
          completedAt: sessions.completedAt,
          durationSeconds: sessions.durationSeconds,
          createdAt: sessions.createdAt,
          repoFullName: repos.fullName,
        })
        .from(sessions)
        .innerJoin(repos, eq(repos.id, sessions.repoId))
        .where(and(...conditions))
        .orderBy(desc(sessions.createdAt));
      return rows;
    },

    async findSessionById(id) {
      const rows = await db
        .select({
          id: sessions.id,
          userId: sessions.userId,
          repoId: sessions.repoId,
          status: sessions.status,
          branch: sessions.branch,
          request: sessions.request,
          model: sessions.model,
          planJson: sessions.planJson,
          vmIp: sessions.vmIp,
          vmPort: sessions.vmPort,
          prUrl: sessions.prUrl,
          prState: sessions.prState,
          checkpointPhase: sessions.checkpointPhase,
          checkpointState: sessions.checkpointState,
          startedAt: sessions.startedAt,
          completedAt: sessions.completedAt,
          durationSeconds: sessions.durationSeconds,
          createdAt: sessions.createdAt,
          repoFullName: repos.fullName,
        })
        .from(sessions)
        .innerJoin(repos, eq(repos.id, sessions.repoId))
        .where(eq(sessions.id, id))
        .limit(1);
      const session = rows[0];
      if (!session) return null;

      const sessionEvents = await db
        .select()
        .from(events)
        .where(eq(events.sessionId, id))
        .orderBy(desc(events.createdAt))
        .limit(100);

      const sessionDiffs = await db
        .select()
        .from(diffs)
        .where(eq(diffs.sessionId, id))
        .orderBy(desc(diffs.createdAt));

      return { ...session, events: sessionEvents, diffs: sessionDiffs };
    },

    async createSession(input) {
      const [row] = await db.insert(sessions).values(input).returning();
      if (!row) throw new Error('failed to create session');
      return row;
    },

    async updateSessionStatus(id, status) {
      const patch: Partial<typeof sessions.$inferInsert> = { status };
      if (status === 'running') {
        const [existing] = await db
          .select({ startedAt: sessions.startedAt })
          .from(sessions)
          .where(eq(sessions.id, id))
          .limit(1);
        if (existing && existing.startedAt === null) {
          patch.startedAt = new Date();
        }
      }
      const [row] = await db
        .update(sessions)
        .set(patch)
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async updateSessionVm(id, fields) {
      const [row] = await db
        .update(sessions)
        .set({ vmIp: fields.vmIp, vmPort: fields.vmPort })
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async updateSessionPrUrl(id, prUrl) {
      const [row] = await db
        .update(sessions)
        .set({ prUrl, prState: 'open' })
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async updateSessionPrState(id, prState) {
      const [row] = await db
        .update(sessions)
        .set({ prState })
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async findSessionByPrUrl(prUrl) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.prUrl, prUrl))
        .limit(1);
      return rows[0] ?? null;
    },

    async checkpointSession(id, fields) {
      const [row] = await db
        .update(sessions)
        .set({
          checkpointPhase: fields.phase,
          checkpointState: fields.state as Session['checkpointState'],
        })
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async getSessionCheckpoint(id) {
      const rows = await db
        .select({
          phase: sessions.checkpointPhase,
          state: sessions.checkpointState,
        })
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      const row = rows[0];
      if (!row || !row.phase) return null;
      return { phase: row.phase, state: row.state };
    },

    async clearSessionCheckpoint(id) {
      const [row] = await db
        .update(sessions)
        .set({ checkpointPhase: null, checkpointState: null })
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async completeSession(id, fields) {
      const [row] = await db
        .update(sessions)
        .set({
          completedAt: fields.completedAt,
          durationSeconds: fields.durationSeconds,
        })
        .where(eq(sessions.id, id))
        .returning();
      if (!row) throw new Error('session not found');
      return row;
    },

    async createEvent(sessionId, type, payload) {
      const [row] = await db
        .insert(events)
        .values({
          sessionId,
          type,
          payload: payload as Event['payload'],
        })
        .returning();
      if (!row) throw new Error('failed to create event');
      return row;
    },

    async getRecentEvents(sessionId, limit) {
      return db
        .select()
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .orderBy(desc(events.createdAt))
        .limit(limit);
    },

    async setUserStripeCustomer(userId, customerId) {
      const [row] = await db
        .update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.id, userId))
        .returning();
      if (!row) throw new Error('user not found');
      return row;
    },

    async setUserSubscription(userId, fields) {
      const [row] = await db
        .update(users)
        .set({
          stripeSubscriptionId: fields.subscriptionId,
          planTier: fields.planTier,
        })
        .where(eq(users.id, userId))
        .returning();
      if (!row) throw new Error('user not found');
      return row;
    },

    async createUsageRecord(input) {
      const [row] = await db
        .insert(usageRecords)
        .values({
          userId: input.userId,
          sessionId: input.sessionId,
          minutes: input.minutes,
        })
        .returning();
      if (!row) throw new Error('failed to create usage record');
      return row;
    },

    async markUsageReported(id) {
      const [row] = await db
        .update(usageRecords)
        .set({ reportedAt: new Date() })
        .where(eq(usageRecords.id, id))
        .returning();
      if (!row) throw new Error('usage record not found');
      return row;
    },

    async listUnreportedUsage(userId) {
      return db
        .select()
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            sql`${usageRecords.reportedAt} is null`,
          ),
        );
    },

    async listUsageBySince(userId, since) {
      return db
        .select()
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            sql`${usageRecords.createdAt} >= ${since}`,
          ),
        )
        .orderBy(desc(usageRecords.createdAt));
    },

    async getRepoEmbedding(repoId) {
      const rows = await db
        .select()
        .from(repoEmbeddings)
        .where(eq(repoEmbeddings.repoId, repoId))
        .limit(1);
      return rows[0] ?? null;
    },

    async upsertRepoEmbedding(repoId, data) {
      const existing = await db
        .select()
        .from(repoEmbeddings)
        .where(eq(repoEmbeddings.repoId, repoId))
        .limit(1);
      if (existing[0]) {
        const [row] = await db
          .update(repoEmbeddings)
          .set({
            indexVersion: data.indexVersion,
            chunkCount: data.chunkCount,
            status: data.status,
            errorMessage: data.errorMessage ?? null,
            storagePath: data.storagePath ?? null,
            indexedAt: data.indexedAt ?? null,
          })
          .where(eq(repoEmbeddings.repoId, repoId))
          .returning();
        if (!row) throw new Error('failed to update repo embedding');
        return row;
      }
      const [row] = await db
        .insert(repoEmbeddings)
        .values({
          repoId,
          indexVersion: data.indexVersion,
          chunkCount: data.chunkCount,
          status: data.status,
          errorMessage: data.errorMessage ?? null,
          storagePath: data.storagePath ?? null,
          indexedAt: data.indexedAt ?? null,
        })
        .returning();
      if (!row) throw new Error('failed to create repo embedding');
      return row;
    },

    async addWaitlistSignup(email, source) {
      try {
        await db.insert(waitlistSignups).values({ email, source });
        return true;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') return false;
        throw err;
      }
    },

    async countWaitlistSignups() {
      const rows = await db
        .select({ id: waitlistSignups.id })
        .from(waitlistSignups);
      return rows.length;
    },

    async listDiffsBySession(sessionId) {
      return db
        .select()
        .from(diffs)
        .where(eq(diffs.sessionId, sessionId))
        .orderBy(desc(diffs.createdAt));
    },

    async findDiffById(id) {
      const rows = await db
        .select()
        .from(diffs)
        .where(eq(diffs.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateDiffStatus(id, status) {
      const [row] = await db
        .update(diffs)
        .set({ status })
        .where(eq(diffs.id, id))
        .returning();
      if (!row) throw new Error('diff not found');
      return row;
    },

    async approveAllPendingDiffs(sessionId) {
      const updated = await db
        .update(diffs)
        .set({ status: 'approved' })
        .where(
          and(eq(diffs.sessionId, sessionId), eq(diffs.status, 'pending')),
        )
        .returning({ id: diffs.id });
      return updated.length;
    },

    async createDiff(input) {
      const [row] = await db
        .insert(diffs)
        .values({
          sessionId: input.sessionId,
          filepath: input.filepath,
          originalContent: input.originalContent,
          newContent: input.newContent,
          status: 'pending',
        })
        .returning();
      if (!row) throw new Error('failed to create diff');
      return row;
    },
  };
}
