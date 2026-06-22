'use client';
import Link from 'next/link';
import { useState } from 'react';

interface NavProps {
  variant: 'landing' | 'writeup';
}

const innerStyle: React.CSSProperties = {
  maxWidth: '768px',
  margin: '0 auto',
  padding: '0 24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: '60px',
};

const linkStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.5)',
  textDecoration: 'none',
  fontSize: '14px',
  fontWeight: 400,
};

function CopyPill() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText('npm install -g anvil-agent');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      style={{
        fontFamily: 'var(--font-geist-mono)',
        fontSize: '12px',
        color: copied ? '#4ade80' : 'rgba(255,255,255,0.4)',
        backgroundColor: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '6px',
        padding: '5px 12px',
        cursor: 'pointer',
        transition: 'color 0.15s, background-color 0.15s',
      }}
    >
      {copied ? 'Copied!' : 'npm install -g anvil-agent'}
    </button>
  );
}

export default function Nav({ variant }: NavProps) {
  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(0,0,0,0.7)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div style={innerStyle}>
        {variant === 'landing' ? (
          <>
            <Link
              href="/"
              style={{
                color: '#ffffff',
                textDecoration: 'none',
                fontSize: '15px',
                fontWeight: 500,
                letterSpacing: '-0.01em',
              }}
            >
              Anvil
            </Link>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
              <Link href="/writeup" style={linkStyle}>
                Writeup
              </Link>
              <a href="https://github.com/arpjw/anvil" style={linkStyle}>
                GitHub
              </a>
              <CopyPill />
            </div>
          </>
        ) : (
          <>
            <Link href="/" style={{ ...linkStyle, color: 'rgba(255,255,255,0.5)' }}>
              ← Anvil
            </Link>
            <a href="https://github.com/arpjw/anvil" style={linkStyle}>
              GitHub
            </a>
          </>
        )}
      </div>
    </nav>
  );
}
