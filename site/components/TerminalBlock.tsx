type LineColor = 'green' | 'amber' | 'blue' | 'red' | 'muted' | 'white';

export interface TerminalLine {
  text: string;
  color?: LineColor;
}

interface TerminalBlockProps {
  lines: TerminalLine[];
}

const colorMap: Record<LineColor, string> = {
  green: '#4ade80',
  amber: '#fbbf24',
  blue: '#60a5fa',
  red: '#f87171',
  muted: 'rgba(255,255,255,0.35)',
  white: '#ffffff',
};

export default function TerminalBlock({ lines }: TerminalBlockProps) {
  return (
    <div
      style={{
        backgroundColor: '#0a0a0a',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#ff5f56' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#ffbd2e' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#27c93f' }} />
      </div>
      <div
        style={{
          padding: '16px 20px',
          fontFamily: 'var(--font-geist-mono)',
          fontSize: '13px',
          lineHeight: '1.8',
        }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{ color: line.color ? colorMap[line.color] : colorMap.muted }}
          >
            {line.text || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}
