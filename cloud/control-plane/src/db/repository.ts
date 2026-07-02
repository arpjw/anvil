import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  diffs,
  events,
  repos,
  sessions,
  users,
  type Diff,
  type DiffStatus,
  type Event,
  type NewSession,
  type Repo,
  type Session,
  type SessionStatus,
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

  listDiffsBySession(sessionId: string): Promise<Diff[]>;
  findDiffById(id: string): Promise<Diff | null>;
  updateDiffStatus(id: string, status: DiffStatus): Promise<Diff>;
  approveAllPendingDiffs(sessionId: string): Promise<number>;
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
  };
}
