import { formatTurnUsageLine } from './usage-core.js';

function pct(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${value}%` : null;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function quotaText(name, quota, windows) {
  if (!quota.available && !windows.some(([, , expired]) => expired)) return null;
  const values = windows.map(([label, value, expired]) => {
    if (expired) return `${label} 已重置，待更新`;
    const used = pct(value);
    return used ? `${label} 已用 ${used}` : null;
  }).filter(Boolean);
  if (!values.length) return null;
  const at = typeof quota.captured_at === 'number' && quota.captured_at > 0
    ? new Date(quota.captured_at) : null;
  const observed = at && Number.isFinite(at.getTime())
    ? at.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '時間不明';
  return `${name} ${values.join(' / ')}（快照 ${observed}${quota.stale ? '，資料偏舊' : ''}）`;
}

export function formatUsageSnapshot(data, turnUsage = null) {
  if (!data || !data.ok) return null;
  const parts = [];
  const turnText = formatTurnUsageLine(turnUsage);
  if (turnText) parts.push(turnText);
  const c = data.claude || {};
  const q = c.quota || {};
  const claude = quotaText('Claude', q, [
    ['5h', q.session_pct, q.session_expired],
    ['7d', q.weekly_pct, q.weekly_expired],
  ]);
  if (claude) parts.push(claude);
  else {
    const today = c.today || {};
    if (today.turns != null) {
      const cost = typeof today.cost === 'number' ? `$${today.cost.toFixed(2)}` : null;
      parts.push(`Claude today ${[fmtTokens(today.tokens), cost, `${today.turns}t`].filter(Boolean).join(' / ')}`);
    }
  }
  const cx = data.codex || {};
  const cq = cx.quota || cx;
  const codex = quotaText('Codex', cq, [
    ['primary', cq.primary_pct, cq.primary_expired],
    ['secondary', cq.secondary_pct, cq.secondary_expired],
  ]);
  if (codex) parts.push(codex);
  return parts.length ? `Usage: ${parts.join(' | ')}` : null;
}
