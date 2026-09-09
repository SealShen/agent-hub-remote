// 遠端重新登入：把 `claude auth login` 的 OAuth flow 拆成「取連結」與「回貼授權碼」
// 兩個 HTTP 步驟，讓使用者在手機上完成，不必回到這台機器。
//
// 實證（2026-09-01，隔離 CLAUDE_CONFIG_DIR 沙箱探測）：
//   - stdio 全 pipe、無 TTY 下 CLI 完全正常，不需要 node-pty
//   - 授權 URL 印在 stdout：https://claude.com/cai/oauth/authorize?...&code_challenge=...&state=...
//   - 提示字串 `Paste code here if prompted > ` 也在 stdout
//   - 錯誤的碼 → stderr `Invalid code. Please make sure the full code was copied.`
//
// 授權碼處理紅線：只從 request body 讀出來、直接寫進 stdin，然後就地丟棄。
// 不進 session 訊息（會落盤 + 廣播）、不進 audit log、不進任何 console 輸出。
// PKCE 的 code_verifier 全程只存在於 CLI 進程記憶體，AHR 不碰。
// AHR 也不讀寫 ~/.claude/.credentials.json——憑證檔的所有權完全屬於 CLI。
//
// 授權分兩段：start 由 step-up action-token 把關（一次性 nonce，用完即廢）；
// 之後改用 start 當場產生的 continuation secret 綁定同一條 flow。這樣使用者只需要
// 做一次 passkey，而拿不到 continuation 的人即使有 L1 存取也無法把自己的授權碼
// 塞進這條 flow（否則這台機器會被登入成攻擊者的帳號）。

import crypto from 'node:crypto';
import { spawnCli } from './cli-launch.js';
import { killTree, verifyClaudeAuth } from './engines.js';

const AUTHORIZE_URL_RE = /(https?:\/\/[^\s'"]*\/oauth\/authorize\?[^\s'"]+)/i;

const URL_WAIT_MS = 30_000;
const LOGIN_TTL_MS = 10 * 60_000;
const CODE_SETTLE_MS = 20_000;

let pending = null;

export function reloginStatus() {
  if (!pending) return { pending: false };
  return { pending: true, startedAt: pending.startedAt, expiresAt: pending.expiresAt };
}

export function cancelRelogin() {
  if (!pending) return false;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  try { killTree(p.proc); } catch {}
  return true;
}

function continuationMatches(supplied) {
  if (!pending || !pending.continuation) return false;
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(pending.continuation, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function startRelogin({ spawnImpl = spawnCli } = {}) {
  cancelRelogin();

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.BROWSER = 'none';

  let proc;
  try {
    proc = spawnImpl('claude', ['auth', 'login', '--claudeai'], {
      stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: `spawn failed: ${String(e && e.message || e)}` };
  }

  const startedAt = Date.now();
  const entry = {
    proc, url: null, continuation: crypto.randomBytes(32).toString('base64url'),
    startedAt, expiresAt: startedAt + LOGIN_TTL_MS,
    timer: null, busy: false, stderr: '', exited: false,
  };
  pending = entry;

  entry.timer = setTimeout(() => {
    if (pending === entry) cancelRelogin();
  }, LOGIN_TTL_MS);
  if (entry.timer.unref) entry.timer.unref();

  proc.on('close', () => { entry.exited = true; });
  proc.stderr.on('data', d => {
    entry.stderr = (entry.stderr + d.toString()).slice(-2000);
  });

  const url = await new Promise(resolve => {
    let buf = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      proc.stdout.off('data', onData);
      resolve(value);
    };
    const onData = d => {
      buf = (buf + d.toString()).slice(-8000);
      const m = buf.match(AUTHORIZE_URL_RE);
      if (m) finish(m[1]);
    };
    const waitTimer = setTimeout(() => finish(null), URL_WAIT_MS);
    if (waitTimer.unref) waitTimer.unref();
    proc.stdout.on('data', onData);
    proc.once('close', () => finish(null));
    proc.once('error', () => finish(null));
  });

  if (!url) {
    const detail = entry.stderr.trim().slice(-300);
    cancelRelogin();
    return { ok: false, error: detail || 'CLI 未在時限內提供授權連結' };
  }

  entry.url = url;
  return { ok: true, url, continuation: entry.continuation, startedAt: entry.startedAt, expiresAt: entry.expiresAt };
}

export async function submitReloginCode(continuation, rawCode, { verify = verifyClaudeAuth } = {}) {
  if (!pending) return { ok: false, error: 'no pending login', restart: true };
  if (!continuationMatches(continuation)) return { ok: false, error: 'continuation mismatch', restart: true };
  if (pending.busy) return { ok: false, error: 'a code is already being verified' };

  const code = String(rawCode == null ? '' : rawCode).trim();
  if (!code) return { ok: false, error: 'code required' };

  const entry = pending;
  entry.busy = true;
  try {
    if (entry.exited || !entry.proc.stdin || !entry.proc.stdin.writable) {
      cancelRelogin();
      return { ok: false, error: '登入流程已結束，請重新開始', restart: true };
    }
    try {
      entry.proc.stdin.write(code + '\n');
    } catch (e) {
      cancelRelogin();
      return { ok: false, error: `寫入失敗：${String(e && e.message || e)}`, restart: true };
    }

    await new Promise(resolve => {
      if (entry.exited) return resolve();
      const t = setTimeout(resolve, CODE_SETTLE_MS);
      if (t.unref) t.unref();
      entry.proc.once('close', () => { clearTimeout(t); resolve(); });
    });

    const status = await verify();
    if (status.loggedIn === true) {
      cancelRelogin();
      return { ok: true, loggedIn: true };
    }

    const canRetry = !entry.exited && !!entry.proc.stdin && entry.proc.stdin.writable;
    const hint = /invalid code/i.test(entry.stderr) ? '授權碼無效或未完整複製' : '登入尚未完成';
    if (!canRetry) {
      cancelRelogin();
      return { ok: false, error: `${hint}，請重新開始登入`, restart: true };
    }
    return { ok: false, error: `${hint}，可直接再貼一次`, restart: false };
  } finally {
    if (pending === entry) entry.busy = false;
  }
}
