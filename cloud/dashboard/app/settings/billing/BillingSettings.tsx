'use client';

import { useState } from 'react';
import useSWR from 'swr';
import {
  getUsage,
  openBillingPortal,
  startCheckout,
  type UsageResponse,
} from '@/lib/api';

export function BillingSettings() {
  const { data, error, isLoading, mutate } = useSWR<UsageResponse>(
    '/billing/usage',
    getUsage,
    { refreshInterval: 30_000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function upgrade(plan: 'pro' | 'team') {
    setBusy(plan);
    setErrMsg(null);
    try {
      const res = await startCheckout(plan);
      window.location.href = res.url;
    } catch (err) {
      setErrMsg((err as Error).message);
      setBusy(null);
    }
  }

  async function portal() {
    setBusy('portal');
    setErrMsg(null);
    try {
      const res = await openBillingPortal();
      window.location.href = res.url;
    } catch (err) {
      setErrMsg((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-medium mb-8">Billing</h1>

      {error && (
        <div
          className="rounded-md p-4 mb-6 text-sm"
          style={{
            backgroundColor: '#111111',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            color: '#f87171',
          }}
        >
          Failed to load billing info.
        </div>
      )}
      {errMsg && (
        <div
          className="rounded-md p-3 mb-6 text-sm"
          style={{
            backgroundColor: '#111111',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            color: '#f87171',
          }}
        >
          {errMsg}
        </div>
      )}

      {isLoading && !data && (
        <div className="text-sm" style={{ color: '#6b7280' }}>
          Loading…
        </div>
      )}

      {data && (
        <>
          <section
            className="rounded-md p-5 mb-6"
            style={{ backgroundColor: '#111111', border: '1px solid #1f1f1f' }}
          >
            <h2
              className="text-[11px] uppercase tracking-wider font-mono mb-2"
              style={{ color: '#6b7280' }}
            >
              Current period
            </h2>
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-medium">{data.minutes}</span>
              <span className="text-sm" style={{ color: '#6b7280' }}>
                minute{data.minutes === 1 ? '' : 's'} used
              </span>
            </div>
            <p className="text-xs mt-2" style={{ color: '#6b7280' }}>
              Started {new Date(data.period.start).toLocaleDateString()} · Plan:{' '}
              <span style={{ color: '#f0f0f0' }}>{data.planTier}</span>
              {data.planTier === 'free' && (
                <>
                  {' · '}
                  {data.freeMinutesPerMonth} free minutes / month
                </>
              )}
            </p>
          </section>

          <section
            className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8"
          >
            <PlanCard
              plan="pro"
              title="Pro"
              subtitle="Individual"
              price="$20/mo + usage"
              features={[
                'Metered VM minutes',
                'Priority queue',
                'Unlimited private repos',
              ]}
              currentTier={data.planTier}
              onUpgrade={() => upgrade('pro')}
              busy={busy === 'pro'}
            />
            <PlanCard
              plan="team"
              title="Team"
              subtitle="For collaborators"
              price="$50/mo + usage"
              features={['Everything in Pro', 'Shared repos', 'SSO (soon)']}
              currentTier={data.planTier}
              onUpgrade={() => upgrade('team')}
              busy={busy === 'team'}
            />
          </section>

          {data.planTier !== 'free' && (
            <section className="mb-8">
              <button
                onClick={portal}
                disabled={busy === 'portal'}
                className="text-sm underline disabled:opacity-40"
                style={{ color: '#fbbf24' }}
              >
                {busy === 'portal'
                  ? 'Opening billing portal…'
                  : 'Manage subscription in Stripe →'}
              </button>
            </section>
          )}

          <section>
            <h2
              className="text-[11px] uppercase tracking-wider font-mono mb-3"
              style={{ color: '#6b7280' }}
            >
              Session history
            </h2>
            {data.records.length === 0 && (
              <p className="text-sm" style={{ color: '#6b7280' }}>
                No sessions yet this period.
              </p>
            )}
            {data.records.length > 0 && (
              <ul className="space-y-1">
                {data.records.map((r) => (
                  <li
                    key={r.id}
                    className="rounded p-2 flex items-center justify-between text-sm"
                    style={{
                      backgroundColor: '#111111',
                      border: '1px solid #1f1f1f',
                    }}
                  >
                    <span className="font-mono text-xs" style={{ color: '#6b7280' }}>
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                    <span>
                      {r.minutes} min
                      {r.reportedAt ? (
                        <span className="ml-2 text-xs" style={{ color: '#4ade80' }}>
                          reported
                        </span>
                      ) : (
                        <span className="ml-2 text-xs" style={{ color: '#fbbf24' }}>
                          pending
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <button
            onClick={() => mutate()}
            className="mt-6 text-xs underline"
            style={{ color: '#6b7280' }}
          >
            Refresh
          </button>
        </>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  title,
  subtitle,
  price,
  features,
  currentTier,
  onUpgrade,
  busy,
}: {
  plan: 'pro' | 'team';
  title: string;
  subtitle: string;
  price: string;
  features: string[];
  currentTier: string;
  onUpgrade: () => void;
  busy: boolean;
}) {
  const isCurrent = currentTier === plan;
  return (
    <div
      className="rounded-md p-4"
      style={{
        backgroundColor: '#111111',
        border: isCurrent ? '1px solid #fbbf24' : '1px solid #1f1f1f',
      }}
    >
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-base font-medium">{title}</h3>
        {isCurrent && (
          <span
            className="text-[10px] uppercase font-mono tracking-wider"
            style={{ color: '#fbbf24' }}
          >
            current
          </span>
        )}
      </div>
      <p className="text-xs mb-2" style={{ color: '#6b7280' }}>
        {subtitle}
      </p>
      <p className="text-sm mb-3" style={{ color: '#f0f0f0' }}>
        {price}
      </p>
      <ul className="text-xs space-y-1 mb-4" style={{ color: '#6b7280' }}>
        {features.map((f) => (
          <li key={f}>· {f}</li>
        ))}
      </ul>
      <button
        onClick={onUpgrade}
        disabled={isCurrent || busy}
        className="w-full py-1.5 text-sm rounded font-medium disabled:opacity-40"
        style={{
          backgroundColor: isCurrent ? 'transparent' : '#fbbf24',
          color: isCurrent ? '#6b7280' : '#0a0a0a',
          border: isCurrent ? '1px solid #1f1f1f' : '1px solid #fbbf24',
        }}
      >
        {isCurrent ? 'Active' : busy ? 'Opening…' : `Upgrade to ${title}`}
      </button>
    </div>
  );
}
