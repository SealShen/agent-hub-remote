// 用量監測面板 —— 概念對齊 aqua5230/usage（不打 API，只讀本機檔）。
// 來源見 usage-core.js；後端 GET /usage。沿用 index.html 既有終端風 class。

const { useState: useStateU, useEffect: useEffectU, useRef: useRefU } = React;

function _pctColor(p) {
  if (p == null) return 'var(--fg-mute)';
  if (p >= 90) return 'var(--st-error)';
  if (p >= 70) return 'var(--st-interrupted)';
  return 'var(--st-running)';
}

function _countdown(ms) {
  if (!ms) return null;
  const d = ms - Date.now();
  if (d <= 0) return '即將重置';
  const h = Math.floor(d / 3600000);
  const m = Math.floor((d % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m 後重置` : `${m}m 後重置`;
}

function _fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// 進度條：label 在上，bar + 右側百分比
function Bar({ label, pct, sub }) {
  const col = _pctColor(pct);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: 'var(--fg)', flex: 1 }}>{label}</span>
        <span style={{ fontSize: 15, fontWeight: 600, color: col }}>
          {pct == null ? '—' : pct + '%'}
        </span>
      </div>
      <div style={{ height: 6, background: 'var(--raised)', border: '1px solid var(--border)' }}>
        <div style={{
          height: '100%', width: Math.min(100, pct || 0) + '%',
          background: col, transition: 'width 240ms ease',
        }} />
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Usage({ onClose }) {
  const [data, setData] = useStateU(null);
  const [err, setErr] = useStateU(null);
  const [loading, setLoading] = useStateU(false);
  const timer = useRefU(null);

  async function load(force) {
    setLoading(true);
    try {
      const u = await window.AHR.usage(force);
      setData(u); setErr(null);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffectU(() => {
    load(false);
    timer.current = setInterval(() => load(false), 30000);
    const onTurnEnd = () => load(true);
    window.addEventListener('ahr_usage_update', onTurnEnd);
    return () => {
      timer.current && clearInterval(timer.current);
      window.removeEventListener('ahr_usage_update', onTurnEnd);
    };
  }, []);

  const q = data && data.claude && data.claude.quota;
  const today = data && data.claude && data.claude.today;
  const w5 = data && data.claude && data.claude.window5h;
  const series = (data && data.claude && data.claude.series7d) || [];
  const cx = data && data.codex;
  const cxQuota = cx && (cx.quota || cx);
  const cxToday = cx && cx.today;
  const cxW5 = cx && cx.window5h;
  const maxTok = Math.max(1, ...series.map(s => s.tokens || 0));

  return (
    <div className="sheet full">
      <div className="sheet-head">
        <button className="nav-btn ic-x" onClick={onClose} />
        <span className="crumb"><span className="crumb-cmd">/usage</span> · 用量監測</span>
        <button className="nav-btn" onClick={() => load(true)}
          style={{ fontSize: 13, color: loading ? 'var(--fg-mute)' : 'var(--fg-soft)' }}>↻</button>
      </div>

      <div className="sheet-body">
        {err && (
          <div className="sec"><div style={{ color: 'var(--st-error)', fontSize: 12 }}>讀取失敗：{err}</div></div>
        )}

        {/* 卡片 1：Claude 訂閱配額 */}
        <div className="sec">
          <div className="sec-h">claude 訂閱配額
            <span className="sec-hint">5 小時 / 7 天滾動視窗</span>
          </div>
          {q && q.available ? (
            <>
              <Bar label="Session（5h）" pct={q.session_pct}
                   sub={_countdown(q.session_reset_ms)} />
              <Bar label="Weekly（7d）" pct={q.weekly_pct}
                   sub={_countdown(q.weekly_reset_ms)} />
              {(q.session_expired || q.weekly_expired) && <div style={{ fontSize: 11, color: 'var(--st-interrupted)' }}>
                ⚠ {[q.session_expired && '5h', q.weekly_expired && '7d'].filter(Boolean).join(' / ')} 視窗已重置，等下一筆讀數</div>}
              {q.stale && <div style={{ fontSize: 11, color: 'var(--st-interrupted)' }}>
                ⚠ 配額快照偏舊（{q.source === 'api'
                  ? 'API 配額快照已超過 5 分鐘未更新'
                  : 'Claude Code 狀態列已超過 1h 未刷新'}）</div>}
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.6 }}>
              尚無配額資料。statusLine hook 已安裝，待 Claude Code（終端 session）
              下次狀態列刷新後自動填入 5h/7d %。
              {q && q.reason ? <div style={{ marginTop: 4 }}>· {q.reason}</div> : null}
            </div>
          )}
        </div>

        {/* 卡片 2：今日 + 5h 視窗 token */}
        <div className="sec">
          <div className="sec-h">今日用量
            <span className="sec-hint">來自 usage-log.jsonl（每 turn 實測）</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              ['今日 tokens', today ? _fmtTok(today.tokens) : '—'],
              ['今日 turns', today ? today.turns : '—'],
              ['今日 est.$', today ? '$' + today.cost.toFixed(2) : '—'],
              ['近 5h tokens', w5 ? _fmtTok(w5.tokens) : '—'],
            ].map(([k, v]) => (
              <div key={k} style={{ flex: 1, border: '1px solid var(--border-strong)', padding: '10px 8px' }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent)' }}>{v}</div>
                <div style={{ fontSize: 10.5, color: 'var(--fg-mute)', marginTop: 3 }}>{k}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 卡片 3：7 日趨勢 */}
        <div className="sec">
          <div className="sec-h">7 日趨勢
            <span className="sec-hint">每日 token 量</span>
          </div>
          {series.map(s => (
            <div key={s.date} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--fg-mute)', width: 42 }}>{s.date.slice(5)}</span>
              <div style={{ flex: 1, height: 14, background: 'var(--raised)' }}>
                <div style={{
                  height: '100%', width: ((s.tokens / maxTok) * 100).toFixed(1) + '%',
                  background: 'var(--accent)', opacity: 0.65,
                }} />
              </div>
              <span style={{ fontSize: 11, color: 'var(--fg-soft)', width: 56, textAlign: 'right' }}>
                {_fmtTok(s.tokens)}
              </span>
            </div>
          ))}
        </div>

        {/* 卡片 4：Codex 配額 */}
        <div className="sec">
          <div className="sec-h">codex 配額
            <span className="sec-hint">最近 session 的 rate_limits</span>
          </div>
          {cxToday && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[
                ['today tokens', _fmtTok(cxToday.tokens)],
                ['today turns', cxToday.turns],
                ['last 5h', cxW5 ? _fmtTok(cxW5.tokens) : '-'],
              ].map(([k, v]) => (
                <div key={k} style={{ flex: 1, border: '1px solid var(--border-strong)', padding: '10px 8px' }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent)' }}>{v}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-mute)', marginTop: 3 }}>{k}</div>
                </div>
              ))}
            </div>
          )}
          {cxQuota && cxQuota.available ? (
            <>
              <Bar label="Primary" pct={cxQuota.primary_pct} />
              {cxQuota.secondary_pct != null && <Bar label="Secondary" pct={cxQuota.secondary_pct} />}
              <div style={{ fontSize: 10.5, color: 'var(--fg-mute)' }}>source: {cxQuota.source}</div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>無 Codex session 配額資料</div>
          )}
        </div>

        <div style={{ padding: '12px 14px 28px', fontSize: 10.5, color: 'var(--fg-mute)' }}>
          僅讀本機檔案 · 不呼叫任何供應商 API · 每 30s 自動更新
          {data && data.generated_at
            ? ' · ' + new Date(data.generated_at).toTimeString().slice(0, 8)
            : ''}
        </div>
      </div>
    </div>
  );
}
