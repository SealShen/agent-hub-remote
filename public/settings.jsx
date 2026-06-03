// settings — full-screen sheet from drawer's footer "⚙ settings".
// Host · auth · defaults · appearance · notifications · maintenance · about.

const { useState: useStateS, useEffect: useEffectS } = React;

function SetRow({ label, sub, val, valTone, onClick, right }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="set-row" onClick={onClick}>
      <div className="sr-main">
        <div className="sr-label">{label}</div>
        {sub ? <div className="sr-sub">{sub}</div> : null}
      </div>
      {right || (
        <>
          {val != null && <div className={`sr-val ${valTone || ''}`}>{val}</div>}
          {onClick && <span className="sr-arrow">›</span>}
        </>
      )}
    </Tag>
  );
}

function psSingleQuote(value) {
  return "'" + String(value || '').replace(/'/g, "''") + "'";
}

function Settings({ onClose }) {
  // local UI state — these are mocks; the real values would round-trip via API.
  const [host,     setHost]     = useStateS(typeof window !== 'undefined' ? window.location.hostname : 'agent-hub');
  const [theme,    setTheme]    = useStateS('terminal');
  const [density,  setDensity]  = useStateS('regular');
  const [defEng,   setDefEng]   = useStateS('claude');
  const [defModel, setDefModel] = useStateS('sonnet');
  const [notifApprove, setNotifApprove] = useStateS(true);
  const [notifDone,    setNotifDone]    = useStateS(true);
  const [notifOutput,  setNotifOutput]  = useStateS(
    window.AHRNotifications ? window.AHRNotifications.status() : 'unsupported'
  );
  const [logLevel, setLogLevel] = useStateS('info');
  const [passkeys, setPasskeys] = useStateS({ loading: true, count: 0, enrollEnabled: false });
  const enrollFlagPath = passkeys.enrollFlagPath || '.\\.state\\auth\\enroll.flag';
  const enrollFlagCommand = `New-Item -ItemType File -Force ${psSingleQuote(enrollFlagPath)}`;

  async function refreshPasskeys() {
    if (!window.AHR || !window.AHR.passkeyStatus) return;
    try {
      setPasskeys(await window.AHR.passkeyStatus());
    } catch (e) {
      setPasskeys({ loading: false, error: e.message || String(e), count: 0, enrollEnabled: false });
    }
  }

  useEffectS(() => { refreshPasskeys(); }, []);

  async function enrollPasskey() {
    try {
      await window.AHR.enrollPasskey(host || 'agent-hub');
      await refreshPasskeys();
      window.alert('Passkey enrolled');
    } catch (e) {
      window.alert('Passkey enrollment failed: ' + (e.message || String(e)));
      await refreshPasskeys();
    }
  }

  async function toggleOutputNotifications() {
    if (!window.AHRNotifications) return;
    const next = notifOutput === 'enabled'
      ? window.AHRNotifications.disable()
      : await window.AHRNotifications.enable();
    setNotifOutput(next);
  }

  return (
    <>
      <div className="sheet-scrim" onClick={onClose}/>
      <div className="sheet full">
        <div className="sheet-head">
          <button className="nav-btn" onClick={onClose} aria-label="back">
            <span className="ic-x"/>
          </button>
          <div className="crumb">
            <span className="crumb-cmd">settings</span>
          </div>
        </div>

        <div className="sheet-body">
          {/* HOST */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>host</div>
            <SetRow
              label="agent-hub server"
              sub={host}
              val="connected"
              valTone="ok"
              onClick={() => {}}
            />
            <SetRow
              label="tailscale"
              sub={host}
              val="online"
              valTone="ok"
            />
            <SetRow
              label="step-up backup"
              sub="TOTP"
              val="enabled"
              valTone="ok"
            />
            <SetRow
              label="ping"
              val="42 ms"
            />
          </div>

          {/* STEP-UP */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>step-up</div>
            <SetRow
              label="passkeys"
              sub={passkeys.error
                ? passkeys.error
                : `${passkeys.count || 0} enrolled · ${passkeys.rpId || host}`}
              val={passkeys.loading ? '…' : (passkeys.enrollEnabled ? 'enroll open' : 'locked')}
              valTone={passkeys.error ? 'warn' : (passkeys.enrollEnabled ? 'warn' : 'ok')}
              right={passkeys.enrollEnabled ? (
                <button className="btn" onClick={enrollPasskey}>enroll</button>
              ) : (
                <button className="btn" onClick={refreshPasskeys} disabled={passkeys.loading}>refresh</button>
              )}
            />
            {!passkeys.loading && !passkeys.error && !passkeys.enrollEnabled && (
              <div style={{ padding: '4px 14px 14px', fontSize: 13, lineHeight: 1.55, color: 'var(--st-fg-soft, #9aa)' }}>
                <div style={{ marginBottom: 8 }}>
                  {passkeys.count > 0
                    ? '要再新增 passkey，先在伺服器本機開啟 enrollment：'
                    : '還沒有 passkey。先在伺服器本機建立 enrollment flag，UI 才能讓你註冊：'}
                </div>
                <pre style={{
                  background: 'var(--st-bg-soft, #1a1a1a)',
                  border: '1px solid var(--st-border, #2a2a2a)',
                  borderRadius: 4,
                  padding: '8px 10px',
                  margin: 0,
                  fontSize: 12,
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
{enrollFlagCommand}
                </pre>
                {!passkeys.enrollFlagPath && (
                  <div style={{ marginTop: 6, opacity: 0.75 }}>
                    Run this from the agent-hub-remote directory.
                  </div>
                )}
                <div style={{ marginTop: 8, opacity: 0.75 }}>
                  建好後按上面 <strong>refresh</strong>，<em>enroll</em> 按鈕就會出現。註冊完 flag 可以刪掉以重新上鎖。
                </div>
              </div>
            )}
          </div>

          {/* DEFAULTS — for new sessions */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>defaults · new session</div>
            <SetRow
              label="engine"
              right={
                <div className="seg">
                  <button className={defEng === 'claude' ? 'on' : ''}
                    onClick={() => { setDefEng('claude'); setDefModel('sonnet'); }}>cl</button>
                  <button className={defEng === 'codex' ? 'on' : ''}
                    onClick={() => { setDefEng('codex'); setDefModel('default'); }}>cx</button>
                </div>
              }
            />
            <SetRow
              label="model"
              val={defModel}
              onClick={() => {}}
              right={<><div className="sr-val">{defModel}</div><span className="sr-arrow">›</span></>}
            />
          </div>

          {/* APPEARANCE */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>appearance</div>
            <SetRow
              label="theme"
              right={
                <div className="seg">
                  <button className={theme === 'terminal' ? 'on' : ''}
                    onClick={() => setTheme('terminal')}>terminal</button>
                  <button className={theme === 'mochi' ? 'on' : ''}
                    onClick={() => setTheme('mochi')}>mochi</button>
                  <button className={theme === 'light' ? 'on' : ''}
                    onClick={() => setTheme('light')}>light</button>
                </div>
              }
            />
            <SetRow
              label="density"
              right={
                <div className="seg">
                  <button className={density === 'compact' ? 'on' : ''}
                    onClick={() => setDensity('compact')}>compact</button>
                  <button className={density === 'regular' ? 'on' : ''}
                    onClick={() => setDensity('regular')}>regular</button>
                </div>
              }
            />
            <SetRow
              label="font"
              sub="jetbrains mono · 14px"
              onClick={() => {}}
              right={<span className="sr-arrow">›</span>}
            />
          </div>

          {/* NOTIFICATIONS */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>notifications</div>
            <div className="row">
              <div className="r-label">
                agent output
                <div className="r-sub">
                  {notifOutput === 'unsupported'
                    ? 'browser notifications unavailable'
                    : notifOutput === 'denied'
                      ? 'permission denied in browser settings'
                      : 'when backgrounded or another thread replies'}
                </div>
              </div>
              <button
                className={`tg ${notifOutput === 'enabled' ? 'on' : ''}`}
                onClick={toggleOutputNotifications}
                disabled={notifOutput === 'unsupported' || notifOutput === 'denied'}>
                [{notifOutput === 'enabled' ? 'x' : ' '}]
              </button>
            </div>
            <div className="row">
              <div className="r-label">
                tool needs approval
                <div className="r-sub">push + badge on app icon</div>
              </div>
              <button
                className={`tg ${notifApprove ? 'on' : ''}`}
                onClick={() => setNotifApprove(v => !v)}>
                [{notifApprove ? 'x' : ' '}]
              </button>
            </div>
            <div className="row">
              <div className="r-label">
                session finished
                <div className="r-sub">when running session goes idle</div>
              </div>
              <button
                className={`tg ${notifDone ? 'on' : ''}`}
                onClick={() => setNotifDone(v => !v)}>
                [{notifDone ? 'x' : ' '}]
              </button>
            </div>
          </div>

          {/* MAINTENANCE */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>maintenance</div>
            <SetRow
              label="log level"
              right={
                <div className="seg">
                  {['warn', 'info', 'debug'].map(l => (
                    <button key={l} className={logLevel === l ? 'on' : ''}
                      onClick={() => setLogLevel(l)}>{l}</button>
                  ))}
                </div>
              }
            />
            <SetRow
              label="export sessions"
              sub="JSONL bundle · all projects"
              onClick={() => {}}
              right={<span className="sr-arrow">›</span>}
            />
            <SetRow
              label="clear cache"
              sub="local thread tail · 4.2 mb"
              onClick={() => {}}
              right={<span className="sr-arrow">›</span>}
            />
            <SetRow
              label="sign out"
              onClick={() => {}}
              right={<span className="sr-arrow" style={{ color: 'var(--st-error)' }}>›</span>}
            />
          </div>

          {/* ABOUT */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>about</div>
            <SetRow label="app version"    val="v0.1.0 (build 81)"/>
            <SetRow label="server version" val="agent-hub 0.4.2"/>
            <SetRow label="last sync"      val="2s ago" valTone="ok"/>
          </div>

          <div className="hint" style={{ padding: '16px 14px 24px' }}>
            <span className="k">↻</span> changes persist locally · server-side
            preferences sync next reconnect
          </div>
        </div>

        <div className="sheet-foot">
          <button className="btn primary" style={{ flex: 1 }} onClick={onClose}>done</button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { Settings, SetRow });
