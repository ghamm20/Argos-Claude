// src/components/panels/ToolsDock.tsx
// ARGOS Tools Dock — shows registered tools, health status, launch buttons
// Polls /api/tools/status every 15s

'use client';

import { useEffect, useState, useCallback } from 'react';

interface Tool {
  id: string;
  name: string;
  description: string;
  port: number | null;
  icon: string;
  category: string;
  status: string;
  online: boolean;
  latencyMs: number | null;
  checkedAt: string;
  openInBrowser: boolean;
  notes: string;
}

const POLL_INTERVAL_MS = 15_000;

const ICONS: Record<string, string> = {
  globe: '🌐',
  agent: '🤖',
  lab: '🧪',
};

const CATEGORY_LABELS: Record<string, string> = {
  intelligence: 'INTELLIGENCE',
  automation: 'AUTOMATION',
  playground: 'PLAYGROUND',
};

function StatusDot({ online, foundation }: { online: boolean; foundation: boolean }) {
  if (foundation) return <span style={{ color: '#555', fontSize: 10 }}>PENDING</span>;
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: online ? '#22c55e' : '#ef4444',
        boxShadow: online ? '0 0 6px #22c55e' : 'none',
        flexShrink: 0,
      }}
    />
  );
}

function ToolCard({ tool }: { tool: Tool }) {
  const isFoundation = tool.status === 'foundation';
  const url = tool.port ? `http://127.0.0.1:${tool.port}` : null;

  const handleLaunch = () => {
    if (url) window.open(url, '_blank', 'noopener');
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        marginBottom: 6,
        opacity: isFoundation ? 0.5 : 1,
      }}
    >
      <span style={{ fontSize: 18, flexShrink: 0 }}>{ICONS[tool.icon] ?? '🔧'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 2,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#e2e8f0',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tool.name}
          </span>
          <StatusDot online={tool.online} foundation={isFoundation} />
          {tool.online && tool.latencyMs !== null && (
            <span style={{ fontSize: 10, color: '#64748b', marginLeft: 2 }}>
              {tool.latencyMs}ms
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#64748b',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {tool.description}
        </div>
      </div>
      {!isFoundation && url && (
        <button
          onClick={handleLaunch}
          disabled={!tool.online}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            borderRadius: 4,
            border: 'none',
            cursor: tool.online ? 'pointer' : 'not-allowed',
            background: tool.online ? 'rgba(99,102,241,0.8)' : 'rgba(255,255,255,0.06)',
            color: tool.online ? '#fff' : '#475569',
            fontWeight: 600,
            flexShrink: 0,
            transition: 'background 0.15s',
          }}
        >
          {tool.online ? 'OPEN' : 'DOWN'}
        </button>
      )}
    </div>
  );
}

export function ToolsDock() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/tools/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTools(data.tools ?? []);
      setLastChecked(new Date().toLocaleTimeString());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Group by category
  const byCategory = tools.reduce<Record<string, Tool[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  const onlineCount = tools.filter((t) => t.online).length;
  const activeCount = tools.filter((t) => t.status !== 'foundation').length;

  return (
    <div
      style={{
        padding: '12px 14px',
        fontFamily: 'var(--font-mono, monospace)',
        color: '#94a3b8',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#64748b' }}>
          TOOLS
        </span>
        {!loading && (
          <span style={{ fontSize: 10, color: '#334155' }}>
            {onlineCount}/{activeCount} ONLINE
            {lastChecked && <> · {lastChecked}</>}
          </span>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 11, color: '#334155', textAlign: 'center', padding: '12px 0' }}>
          Checking tools...
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 8 }}>
          Registry error: {error}
        </div>
      )}

      {/* Tool cards grouped by category */}
      {Object.entries(byCategory).map(([category, categoryTools]) => (
        <div key={category} style={{ marginBottom: 10 }}>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.12em',
              color: '#334155',
              marginBottom: 5,
            }}
          >
            {CATEGORY_LABELS[category] ?? category.toUpperCase()}
          </div>
          {categoryTools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      ))}
    </div>
  );
}
