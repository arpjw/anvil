import Link from 'next/link';
import Nav from '@/components/Nav';
import TerminalBlock from '@/components/TerminalBlock';
import type { TerminalLine } from '@/components/TerminalBlock';

const containerStyle: React.CSSProperties = {
  maxWidth: '768px',
  margin: '0 auto',
  padding: '0 24px',
  width: '100%',
};

const section1Lines: TerminalLine[] = [
  { text: 'shadow[1/3] db.ts · validating...', color: 'muted' },
  { text: '2 type errors returned to executor', color: 'red' },
  { text: 'shadow[2/3] db.ts · self-correcting...', color: 'muted' },
  { text: 'committed · pre-existing bug caught (all.size → all.length)', color: 'green' },
];

const section2Lines: TerminalLine[] = [
  { text: 'anvilai "@src/auth.ts has a session expiry bug, fix it" .', color: 'amber' },
  { text: 'anvilai "@AppError needs an error code field" .', color: 'amber' },
  { text: 'anvilai "@https://docs.stripe.com/api implement payment flow" .', color: 'amber' },
];

const section3Lines: TerminalLine[] = [
  { text: 'Goal: Rename User interface to Account', color: 'muted' },
  { text: 'Files to modify: types.ts, db.ts, auth.ts', color: 'muted' },
  { text: 'Steps: 19 targeted changes across 3 files', color: 'muted' },
  { text: 'Risks: function names are intentionally unchanged', color: 'muted' },
  { text: 'Approve plan? (y/n/revise):', color: 'white' },
];

const installLines: TerminalLine[] = [
  { text: 'npm install -g anvil-agent', color: 'white' },
  { text: 'anvilai init', color: 'white' },
  { text: 'anvilai "your request here" .', color: 'white' },
];

export default function Home() {
  return (
    <main>
      <Nav variant="landing" />

      {/* Hero */}
      <section style={{ ...containerStyle, paddingTop: '96px', paddingBottom: '72px' }}>
        <h1
          style={{
            fontSize: 'clamp(36px, 6vw, 58px)',
            fontWeight: 600,
            color: '#ffffff',
            lineHeight: 1.08,
            letterSpacing: '-0.03em',
            marginBottom: '24px',
            maxWidth: '580px',
          }}
        >
          A coding agent that validates its own work.
        </h1>
        <p
          style={{
            fontSize: '17px',
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.75,
            maxWidth: '500px',
            marginBottom: '44px',
            fontWeight: 400,
          }}
        >
          Anvil applies every edit through a shadow workspace before touching your files.
          The language server has to sign off before anything commits to disk.
        </p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <Link
            href="/writeup"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '10px 20px',
              backgroundColor: '#ffffff',
              color: '#000000',
              textDecoration: 'none',
              fontSize: '14px',
              fontWeight: 500,
              borderRadius: '7px',
            }}
          >
            Read the writeup
          </Link>
          <a
            href="https://github.com/arpjw/anvil"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '10px 20px',
              backgroundColor: 'transparent',
              color: 'rgba(255,255,255,0.7)',
              textDecoration: 'none',
              fontSize: '14px',
              fontWeight: 500,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '7px',
            }}
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Terminal demo */}
      <div style={{ ...containerStyle, paddingBottom: '96px' }}>
        <div
          style={{
            backgroundColor: '#060606',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '12px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#ff5f56' }} />
              <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#ffbd2e' }} />
              <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#27c93f' }} />
            </div>
            <span
              style={{
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '12px',
                color: 'rgba(255,255,255,0.2)',
              }}
            >
              anvil — test-repo-2
            </span>
            <div style={{ width: 52 }} />
          </div>

          <div
            style={{
              padding: '24px',
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '13px',
              lineHeight: '1.8',
            }}
          >
            <div style={{ color: 'rgba(255,255,255,0.2)', marginBottom: '16px', fontSize: '12px' }}>
              session e7a12143 · claude-sonnet-4-6
            </div>

            <div style={{ color: 'rgba(255,255,255,0.6)' }}>
              request: Rename the User type to Account across all files
            </div>
            <div style={{ color: 'rgba(255,255,255,0.2)' }}>&nbsp;</div>

            <div style={{ color: 'rgba(255,255,255,0.35)' }}>[Orchestrator] Complex request, spawning planner</div>
            <div style={{ color: 'rgba(255,255,255,0.35)' }}>[Planner] Exploring codebase...</div>
            <div style={{ color: '#60a5fa' }}>[ast_search] query_type=interfaces</div>
            <div style={{ color: 'rgba(255,255,255,0.35)' }}>&nbsp;&nbsp;User [interface, lines 7-13]</div>
            <div style={{ color: '#60a5fa' }}>[find_symbol] symbol=User</div>
            <div style={{ color: 'rgba(255,255,255,0.35)' }}>&nbsp;&nbsp;19 references across 3 files</div>
            <div style={{ color: 'rgba(255,255,255,0.35)' }}>[Planner] Plan written</div>
            <div style={{ color: 'rgba(255,255,255,0.2)' }}>&nbsp;</div>

            <div style={{ color: 'rgba(255,255,255,0.6)' }}>Approve plan? (y/n/revise): y</div>
            <div style={{ color: 'rgba(255,255,255,0.35)' }}>[Executor] Executing approved plan...</div>
            <div style={{ color: '#60a5fa' }}>[write_file] path=db.ts</div>
            <div style={{ color: '#f87171' }}>
              &nbsp;&nbsp;shadow[1/3] db.ts · 2 type errors, retrying...
            </div>
            <div style={{ color: '#60a5fa' }}>[write_file] path=db.ts (attempt 2)</div>
            <div style={{ color: '#4ade80' }}>&nbsp;&nbsp;shadow[2/3] db.ts · committed</div>
            <div style={{ color: '#4ade80' }}>&nbsp;&nbsp;shadow[1/3] auth.ts · committed</div>
            <div style={{ color: '#4ade80' }}>&nbsp;&nbsp;shadow[1/3] types.ts · committed</div>
            <div style={{ color: 'rgba(255,255,255,0.2)' }}>&nbsp;</div>

            <div style={{ color: '#4ade80' }}>
              [Anvil] Done: Renamed User to Account across types.ts, db.ts, auth.ts
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 24px',
              backgroundColor: 'rgba(255,255,255,0.02)',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '12px',
              color: 'rgba(255,255,255,0.2)',
            }}
          >
            <span>claude-sonnet-4-6</span>
            <span style={{ color: '#4ade80' }}>DONE</span>
            <span>22s</span>
          </div>
        </div>
      </div>

      {/* Feature section 1: Validation */}
      <section
        style={{
          ...containerStyle,
          paddingTop: '80px',
          paddingBottom: '80px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <p
          style={{
            fontSize: '11px',
            color: 'rgba(255,255,255,0.25)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: '20px',
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          Validation
        </p>
        <h2
          style={{
            fontSize: '28px',
            fontWeight: 500,
            color: '#ffffff',
            marginBottom: '16px',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
          }}
        >
          Edits are tested before they land.
        </h2>
        <p
          style={{
            fontSize: '16px',
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.8,
            marginBottom: '36px',
            maxWidth: '580px',
          }}
        >
          Cursor implements shadow workspaces as a hidden VS Code window with full editor
          state. Anvil does it at the filesystem level. Every proposed edit goes to a
          temporary copy first, the language server runs diagnostics against it, and only
          a clean result commits to your actual file.
        </p>
        <TerminalBlock lines={section1Lines} />
      </section>

      {/* Feature section 2: Retrieval */}
      <section
        style={{
          ...containerStyle,
          paddingTop: '80px',
          paddingBottom: '80px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <p
          style={{
            fontSize: '11px',
            color: 'rgba(255,255,255,0.25)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: '20px',
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          Retrieval
        </p>
        <h2
          style={{
            fontSize: '28px',
            fontWeight: 500,
            color: '#ffffff',
            marginBottom: '16px',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
          }}
        >
          It navigates codebases, not files.
        </h2>
        <p
          style={{
            fontSize: '16px',
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.8,
            marginBottom: '36px',
            maxWidth: '580px',
          }}
        >
          Most agents read every file and hope the context window contains what they need.
          Anvil uses tree-sitter for AST queries, an LSP client for symbol resolution, and
          ripgrep for text search. The planner explores iteratively and decides what to look
          for based on what it finds.
        </p>
        <TerminalBlock lines={section2Lines} />
      </section>

      {/* Feature section 3: Isolation */}
      <section
        style={{
          ...containerStyle,
          paddingTop: '80px',
          paddingBottom: '80px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <p
          style={{
            fontSize: '11px',
            color: 'rgba(255,255,255,0.25)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: '20px',
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          Isolation
        </p>
        <h2
          style={{
            fontSize: '28px',
            fontWeight: 500,
            color: '#ffffff',
            marginBottom: '16px',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
          }}
        >
          The planner cannot write. The executor cannot wander.
        </h2>
        <p
          style={{
            fontSize: '16px',
            color: 'rgba(255,255,255,0.45)',
            lineHeight: 1.8,
            marginBottom: '36px',
            maxWidth: '580px',
          }}
        >
          Every complex request is split into a Planner that explores with read-only tools
          and an Executor that writes only to the files the plan names. You approve the plan
          before anything is written.
        </p>
        <TerminalBlock lines={section3Lines} />
      </section>

      {/* Install section */}
      <section
        style={{
          ...containerStyle,
          paddingTop: '80px',
          paddingBottom: '80px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <h2
          style={{
            fontSize: '28px',
            fontWeight: 500,
            color: '#ffffff',
            marginBottom: '36px',
            letterSpacing: '-0.02em',
          }}
        >
          Get started
        </h2>
        <TerminalBlock lines={installLines} />
        <p
          style={{
            marginTop: '16px',
            fontSize: '13px',
            color: 'rgba(255,255,255,0.3)',
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          Run{' '}
          <span style={{ color: 'rgba(255,255,255,0.65)' }}>anvilai doctor</span>
          {' '}to verify your setup.
        </p>
      </section>

      {/* Footer */}
      <footer
        style={{
          ...containerStyle,
          paddingTop: '40px',
          paddingBottom: '48px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.25)' }}>Built by Arya Somu</span>
        <div style={{ display: 'flex', gap: '24px' }}>
          <a
            href="https://aryasomu.com"
            style={{ fontSize: '14px', color: 'rgba(255,255,255,0.25)', textDecoration: 'none' }}
          >
            aryasomu.com
          </a>
          <a
            href="https://github.com/arpjw/anvil"
            style={{ fontSize: '14px', color: 'rgba(255,255,255,0.25)', textDecoration: 'none' }}
          >
            github.com/arpjw/anvil
          </a>
        </div>
      </footer>
    </main>
  );
}
