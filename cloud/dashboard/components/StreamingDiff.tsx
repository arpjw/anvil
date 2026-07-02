'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { statsForHunks, type DiffHunk, type FileDiff } from '@/lib/diff-engine';

export interface StreamingDiffProps {
  filepath: string;
  diff: FileDiff;
  isStreaming: boolean;
}

interface FlatLine {
  text: string;
  kind: '+' | '-' | ' ' | 'header';
  hunkIndex: number;
  header: string;
}

function flattenHunks(hunks: DiffHunk[]): FlatLine[] {
  const out: FlatLine[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (!hunk) continue;
    out.push({ text: hunk.header, kind: 'header', hunkIndex: i, header: hunk.header });
    for (const line of hunk.lines) {
      const kind: FlatLine['kind'] =
        line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
      out.push({ text: line, kind, hunkIndex: i, header: hunk.header });
    }
  }
  return out;
}

// Streams diff lines into view with a 20 ms delay each. Skips the animation
// when `isStreaming` is false or the user prefers reduced motion.
export function StreamingDiff({ filepath, diff, isStreaming }: StreamingDiffProps) {
  const [expanded, setExpanded] = useState(true);
  const lines = useMemo(() => flattenHunks(diff.hunks), [diff.hunks]);
  const stats = useMemo(() => statsForHunks(diff.hunks), [diff.hunks]);
  const [visibleCount, setVisibleCount] = useState<number>(
    isStreaming ? 0 : lines.length,
  );
  const linesRef = useRef(lines);

  useEffect(() => {
    linesRef.current = lines;
    if (!isStreaming) {
      setVisibleCount(lines.length);
      return;
    }
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setVisibleCount(lines.length);
      return;
    }
    setVisibleCount(0);
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      setVisibleCount((prev) => {
        if (prev >= linesRef.current.length) {
          clearInterval(interval);
          return prev;
        }
        return prev + 1;
      });
    }, 20);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [lines, isStreaming]);

  const visible = lines.slice(0, visibleCount);
  const streamingActive = isStreaming && visibleCount < lines.length;

  return (
    <div
      className="mx-3 my-3 rounded-md overflow-hidden"
      style={{ backgroundColor: '#0d0d0d', border: '1px solid #1f1f1f' }}
    >
      <div
        className="flex items-center gap-3 px-3 py-2"
        style={{ borderBottom: '1px solid #1f1f1f', backgroundColor: '#111111' }}
      >
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-xs font-mono"
          style={{ color: '#6b7280' }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span
          className="font-mono text-sm truncate flex-1"
          style={{ color: '#f0f0f0' }}
        >
          {filepath}
        </span>
        <span className="text-xs font-mono" style={{ color: '#4ade80' }}>
          +{stats.additions}
        </span>
        <span className="text-xs font-mono" style={{ color: '#f87171' }}>
          −{stats.deletions}
        </span>
        {streamingActive ? (
          <span
            className="text-[10px] uppercase tracking-wider rounded font-mono px-2 py-0.5 animate-pulse"
            style={{ color: '#fbbf24', border: '1px solid #fbbf24' }}
          >
            streaming
          </span>
        ) : (
          <span
            className="text-[10px] uppercase tracking-wider rounded font-mono px-2 py-0.5"
            style={{ color: '#6b7280', border: '1px solid #1f1f1f' }}
          >
            committed
          </span>
        )}
      </div>
      {expanded && (
        <div className="text-[12px] font-mono overflow-x-auto">
          {visible.length === 0 ? (
            <div className="px-3 py-2" style={{ color: '#6b7280' }}>
              Waiting for lines…
            </div>
          ) : (
            visible.map((line, i) => <StreamingLine key={i} line={line} />)
          )}
        </div>
      )}
    </div>
  );
}

function StreamingLine({ line }: { line: FlatLine }) {
  if (line.kind === 'header') {
    return (
      <div
        className="px-3 py-0.5 text-[11px]"
        style={{ color: '#6b7280', backgroundColor: '#0a0a0a' }}
      >
        {line.text}
      </div>
    );
  }
  let color = '#f0f0f0';
  let bg = 'transparent';
  if (line.kind === '+') {
    color = '#4ade80';
    bg = 'rgba(74, 222, 128, 0.06)';
  } else if (line.kind === '-') {
    color = '#f87171';
    bg = 'rgba(248, 113, 113, 0.06)';
  } else {
    color = '#6b7280';
  }
  return (
    <div
      className="px-3 whitespace-pre"
      style={{ color, backgroundColor: bg }}
    >
      {line.text}
    </div>
  );
}
