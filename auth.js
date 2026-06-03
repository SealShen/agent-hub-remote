// Serve-only step-up auth for agent-hub-remote.
// L1: Tailscale Serve network boundary, with a rejectFunnel guardrail.
// L2: owner cookie plus TOTP/Passkey step-up for risky actions.
// Action tokens are one-use, action-scoped, and expire after 60 seconds.
// Never log or persist TOTP_SECRET.
import './env.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import writeFileAtomic from 'write-file-atomic';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = path.join(__dirname, 'auth-audit.jsonl');
const AUTH_STATE_DIR = path.join(__dirname, '.state', 'auth');
const PASSKEYS_PATH = path.join(AUTH_STATE_DIR, 'passkeys.json');
const ENROLL_FLAG_PATH = path.join(AUTH_STATE_DIR, 'enroll.flag');

const ACTION_TOKEN_TTL_MS = 60 * 1000;
const NONCE_GC_INTERVAL_MS = 10 * 60 * 1000;
const LOCK_THRESHOLD = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 5;
const HTTP_PORT = Math.max(1, Math.min(65535, parseInt(process.env.AHR_HTTP_PORT || process.env.AHR_PORT || process.env.AGENT_HUB_PORT || '3334', 10)));
const LOCAL_WEBAUTHN_ORIGIN = HTTP_PORT === 80 ? 'http://localhost' : `http://localhost:${HTTP_PORT}`;
const WEBAUTHN_RP_ID = process.env.AHR_WEBAUTHN_RP_ID
  || (process.env.AHR_TAILNET_HOSTNAME && process.env.AHR_TAILNET_DOMAIN
    ? `${process.env.AHR_TAILNET_HOSTNAME}.${process.env.AHR_TAILNET_DOMAIN}`
    : 'localhost');
const WEBAUTHN_ORIGIN = process.env.AHR_WEBAUTHN_ORIGIN
  || (process.env.AHR_TAILNET_HOSTNAME && process.env.AHR_TAILNET_DOMAIN
    ? `https://${WEBAUTHN_RP_ID}`
    : LOCAL_WEBAUTHN_ORIGIN);
const WEBAUTHN_RP_NAME = 'Agent Hub Remote';
const WEBAUTHN_USER_ID = Buffer.from('agent-hub-remote-owner', 'utf8');

try { fs.mkdirSync(AUTH_STATE_DIR, { recursive: true }); } catch {}

// 危險動作白名單（spec §5.4）
const ACTIONS = new Set(['restart', 'autoallow-on', 'create-with-autoallow']);
// 不需要既有 sessionId 的動作（restart 全域；create-with-autoallow 在 session 建立前簽發）
const SESSIONLESS_ACTIONS = new Set(['restart', 'create-with-autoallow']);

let TOTP_SECRET = process.env.TOTP_SECRET;

export function assertSecret() {
  if (!TOTP_SECRET || !TOTP_SECRET.trim()) {
    console.error(
      '\n[agent-hub-remote] FATAL: 環境變數 TOTP_SECRET 未設定。\n' +
      '  step-up 備援需要 TOTP，缺 secret 拒絕啟動（fail-closed）。\n' +
      '  Set TOTP_SECRET in the user environment, or in a local gitignored .env for a private single-user install.\n'
    );
    process.exit(1);
  }
  TOTP_SECRET = TOTP_SECRET.trim();
}

// ── RFC 4648 base32 解碼 ────────────────────────────────────────────────────
function base32Decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = A.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── RFC 6238 TOTP 驗證（SHA1/6碼/30s/±1）───────────────────────────────────
function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) |
               ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function totpVerify(token) {
  const t = String(token || '').trim();
  if (!/^\d{6}$/.test(t)) return false;
  const key = base32Decode(TOTP_SECRET);
  const step = Math.floor(Date.now() / 1000 / 30);
  const want = Buffer.from(t);
  for (let w = -1; w <= 1; w++) {
    const got = Buffer.from(hotp(key, step + w));
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}

// ── Action-token 簽章（每次啟動隨機，重啟即作廢）───────────────────────────
const STEP_UP_KEY = crypto.randomBytes(32);

function sign(data) {
  return crypto.createHmac('sha256', STEP_UP_KEY).update(data).digest('base64url');
}

function makeActionToken({ sessionId, action }) {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + ACTION_TOKEN_TTL_MS,
    sessionId: sessionId || null,
    action,
    nonce,
  })).toString('base64url');
  return payload + '.' + sign(payload);
}

function parseActionToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const dot = tok.indexOf('.');
  if (dot < 1) return null;
  const payload = tok.slice(0, dot);
  const mac = tok.slice(dot + 1);
  const expect = sign(payload);
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.exp !== 'number' || Date.now() >= data.exp) return null;
    if (!ACTIONS.has(data.action)) return null;
    if (typeof data.nonce !== 'string' || !data.nonce) return null;
    return data;
  } catch {
    return null;
  }
}

// ── Nonce 重放防禦（記憶體 Map，10 分鐘輪詢 GC）─────────────────────────────
const usedNonces = new Map();   // nonce -> expAt
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
}, NONCE_GC_INTERVAL_MS).unref();

// ── Passkey state + challenge cache（PR2）──────────────────────────────────
const passkeyChallenges = new Map(); // `${kind}:${challenge}` -> meta
setInterval(() => {
  const now = Date.now();
  for (const [key, meta] of passkeyChallenges) {
    if (!meta || meta.expAt <= now) passkeyChallenges.delete(key);
  }
}, PASSKEY_CHALLENGE_TTL_MS).unref();

function challengeKey(kind, challenge) {
  return `${kind}:${challenge}`;
}

function putChallenge(kind, challenge, meta) {
  passkeyChallenges.set(challengeKey(kind, challenge), {
    ...meta,
    challenge,
    expAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
  });
}

function popChallenge(kind, challenge) {
  const key = challengeKey(kind, challenge);
  const meta = passkeyChallenges.get(key);
  if (!meta || meta.expAt <= Date.now()) return null;
  passkeyChallenges.delete(key);
  return meta;
}

function readPasskeyStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PASSKEYS_PATH, 'utf8'));
    const credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    return { credentials: credentials.filter(c => c && c.id && c.publicKey) };
  } catch {
    return { credentials: [] };
  }
}

function writePasskeyStore(store) {
  const credentials = Array.isArray(store.credentials) ? store.credentials : [];
  if (credentials.length > MAX_PASSKEYS) {
    throw new Error(`passkey limit exceeded (${credentials.length}/${MAX_PASSKEYS})`);
  }
  const payload = {
    credentials,
  };
  writeFileAtomic.sync(PASSKEYS_PATH, JSON.stringify(payload, null, 2));
}

function passkeyCredentialForVerify(cred) {
  let publicKey;
  try {
    publicKey = new Uint8Array(Buffer.from(cred.publicKey, 'base64url'));
  } catch {
    throw new Error('invalid passkey: malformed publicKey');
  }
  return {
    id: cred.id,
    publicKey,
    // Platform authenticators often report 0, but preserve non-zero counters
    // when available so cloned-authenticator rollback checks still work.
    counter: Number.isFinite(cred.counter) ? cred.counter : 0,
    transports: Array.isArray(cred.transports) ? cred.transports : undefined,
  };
}

function clientChallengeFrom(response) {
  const encoded = response && response.response && response.response.clientDataJSON;
  if (!encoded || typeof encoded !== 'string') return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof data.challenge === 'string' ? data.challenge : null;
  } catch {
    return null;
  }
}

function validateStepUpBody(body) {
  const action = body && body.action;
  const sessionId = body && body.sessionId ? String(body.sessionId) : null;
  if (!ACTIONS.has(action)) return { error: 'invalid action' };
  if (!SESSIONLESS_ACTIONS.has(action) && !sessionId) {
    return { error: 'sessionId required for this action' };
  }
  return { action, sessionId };
}

function sanitizePasskeyName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Passkey';
}

// ── 全域連錯鎖定 ────────────────────────────────────────────────────────────
let failCount = 0;
let lockedUntil = 0;

function isLocked() {
  if (lockedUntil && Date.now() < lockedUntil) return true;
  if (lockedUntil && Date.now() >= lockedUntil) { lockedUntil = 0; failCount = 0; }
  return false;
}

function lockedResponse(req, res) {
  audit(req, false, 'step-up-locked');
  const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
  return res.status(429).json({ ok: false, error: `連錯過多，已鎖定，約 ${mins} 分鐘後再試` });
}

function recordStepUpFailure(req, note) {
  failCount += 1;
  if (failCount >= LOCK_THRESHOLD) {
    lockedUntil = Date.now() + LOCK_WINDOW_MS;
    audit(req, false, 'step-up-fail', `${note}; locked after ${failCount}`);
    return { status: 429, error: '連錯過多，已鎖定 15 分鐘' };
  }
  audit(req, false, 'step-up-fail', `${note} (${failCount}/${LOCK_THRESHOLD})`);
  return { status: 401, error: `驗證失敗（${failCount}/${LOCK_THRESHOLD}）` };
}

// ── 稽核 log（失敗不影響主流程）────────────────────────────────────────────
export function audit(req, ok, event, note) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || '?';
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    ua: (req.headers['user-agent'] || '').slice(0, 120),
    event,
    ok,
    note: note || undefined,
  }) + '\n';
  fs.appendFile(AUDIT_PATH, line, () => {});
}

// ── L1：Funnel-reject middleware（spec §3）─────────────────────────────────
// Tailscale Funnel ingress 永遠插入 `Tailscale-Funnel-Request` header；
// 該 header 由 tailscaled 控制，使用者無法移除。偵測到即 403。
export function rejectFunnel(req, res, next) {
  if (req.headers['tailscale-funnel-request']) {
    audit(req, false, 'funnel-reject');
    return res.status(403).json({ error: 'funnel access disabled; serve only' });
  }
  next();
}

// ── L2：Step-up endpoint（TOTP 路徑；PR1 唯一升權路徑）─────────────────────
export function handleStepUpTotp(req, res) {
  if (isLocked()) {
    return lockedResponse(req, res);
  }
  const { code, sessionId, action } = req.body || {};
  if (!ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: 'invalid action' });
  }
  if (!SESSIONLESS_ACTIONS.has(action) && !sessionId) {
    return res.status(400).json({ ok: false, error: 'sessionId required for this action' });
  }
  if (!totpVerify(code)) {
    const fail = recordStepUpFailure(req, `wrong-code action=${action}`);
    return res.status(fail.status).json({ ok: false, error: fail.error });
  }
  failCount = 0;
  lockedUntil = 0;
  const token = makeActionToken({ sessionId: sessionId || null, action });
  audit(req, true, 'step-up-ok', `action=${action}`);
  return res.json({ ok: true, token, ttlMs: ACTION_TOKEN_TTL_MS });
}

// ── L2：Passkey enrollment + step-up（PR2）─────────────────────────────────
export function handlePasskeyStatus(req, res) {
  const store = readPasskeyStore();
  res.json({
    ok: true,
    rpId: WEBAUTHN_RP_ID,
    origin: WEBAUTHN_ORIGIN,
    count: store.credentials.length,
    enrolled: store.credentials.length > 0,
    enrollEnabled: fs.existsSync(ENROLL_FLAG_PATH),
    enrollFlagPath: ENROLL_FLAG_PATH,
    max: MAX_PASSKEYS,
  });
}

export async function handleEnrollPasskeyStart(req, res) {
  try {
    if (!fs.existsSync(ENROLL_FLAG_PATH)) {
      return res.status(403).json({ error: 'enrollment not enabled' });
    }
    const store = readPasskeyStore();
    if (store.credentials.length >= MAX_PASSKEYS) {
      return res.status(409).json({ error: 'passkey limit reached' });
    }
    const name = sanitizePasskeyName(req.body && req.body.name);
    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userName: 'agent-hub-owner',
      userID: WEBAUTHN_USER_ID,
      userDisplayName: 'Agent Hub Owner',
      timeout: 60_000,
      attestationType: 'none',
      excludeCredentials: store.credentials.map(c => ({
        id: c.id,
        transports: Array.isArray(c.transports) ? c.transports : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    putChallenge('enroll', options.challenge, { name });
    return res.json(options);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}

export async function handleEnrollPasskeyFinish(req, res) {
  try {
    if (!fs.existsSync(ENROLL_FLAG_PATH)) {
      return res.status(403).json({ error: 'enrollment not enabled' });
    }
    const attestation = req.body && req.body.attestation;
    const challenge = clientChallengeFrom(attestation);
    const meta = challenge && popChallenge('enroll', challenge);
    if (!meta) return res.status(400).json({ error: 'invalid or expired challenge' });

    // Consume the enrollment flag before verification — makes it a one-shot ticket
    // even if verification fails (prevents retry with a manipulated attestation).
    try { fs.unlinkSync(ENROLL_FLAG_PATH); } catch {}

    const verified = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: meta.challenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
    if (!verified.verified || !verified.registrationInfo) {
      return res.status(401).json({ error: 'passkey enrollment failed' });
    }

    const store = readPasskeyStore();
    if (store.credentials.length >= MAX_PASSKEYS) {
      return res.status(409).json({ error: 'passkey limit reached' });
    }
    const info = verified.registrationInfo;
    const credential = info.credential;
    if (store.credentials.some(c => c.id === credential.id)) {
      return res.status(409).json({ error: 'passkey already enrolled' });
    }

    const transports = attestation?.response?.transports;
    const saved = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: 0,
      transports: Array.isArray(transports) ? transports : undefined,
      name: meta.name,
      createdAt: new Date().toISOString(),
      credentialDeviceType: info.credentialDeviceType,
      credentialBackedUp: !!info.credentialBackedUp,
    };
    store.credentials.push(saved);
    writePasskeyStore(store);
    audit(req, true, 'enroll-ok', `credential=${saved.id}`);
    return res.json({ ok: true, name: saved.name, credentialId: saved.id });
  } catch (e) {
    audit(req, false, 'enroll-fail', e.message || String(e));
    return res.status(401).json({ error: e.message || String(e) });
  }
}

export async function handleStepUpPasskeyStart(req, res) {
  try {
    if (isLocked()) return lockedResponse(req, res);
    const valid = validateStepUpBody(req.body || {});
    if (valid.error) return res.status(400).json({ ok: false, error: valid.error });

    const store = readPasskeyStore();
    if (!store.credentials.length) {
      return res.status(404).json({ ok: false, error: 'no passkeys enrolled' });
    }
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: store.credentials.map(c => ({
        id: c.id,
        transports: Array.isArray(c.transports) ? c.transports : undefined,
      })),
    });
    putChallenge('step-up', options.challenge, {
      action: valid.action,
      sessionId: valid.sessionId || null,
    });
    return res.json(options);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

export async function handleStepUpPasskeyFinish(req, res) {
  try {
    if (isLocked()) return lockedResponse(req, res);
    const valid = validateStepUpBody(req.body || {});
    if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
    const assertion = req.body && req.body.assertion;
    const challenge = clientChallengeFrom(assertion);
    const meta = challenge && popChallenge('step-up', challenge);
    if (!meta) return res.status(400).json({ ok: false, error: 'invalid or expired challenge' });
    if (meta.action !== valid.action || (meta.sessionId || null) !== (valid.sessionId || null)) {
      return res.status(403).json({ ok: false, error: 'challenge mismatch' });
    }

    const store = readPasskeyStore();
    const cred = store.credentials.find(c => c.id === assertion?.id);
    if (!cred) return res.status(404).json({ ok: false, error: 'passkey not enrolled' });

    const verified = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: meta.challenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: passkeyCredentialForVerify(cred),
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    });
    if (!verified.verified) {
      const fail = recordStepUpFailure(req, `passkey action=${valid.action}`);
      return res.status(fail.status).json({ ok: false, error: fail.error });
    }
    cred.counter = Number.isFinite(verified.authenticationInfo?.newCounter)
      ? verified.authenticationInfo.newCounter
      : (Number.isFinite(cred.counter) ? cred.counter : 0);
    writePasskeyStore(store);
    failCount = 0;
    lockedUntil = 0;
    const token = makeActionToken({ sessionId: valid.sessionId || null, action: valid.action });
    audit(req, true, 'step-up-ok', `action=${valid.action} method=passkey`);
    return res.json({ ok: true, token, ttlMs: ACTION_TOKEN_TTL_MS });
  } catch (e) {
    const fail = recordStepUpFailure(req, `passkey: ${e.message || String(e)}`);
    return res.status(fail.status).json({ ok: false, error: fail.error });
  }
}

// ── L2：Action-token 驗證（spec §5.4）──────────────────────────────────────
// 由危險路由呼叫；驗 token 簽章 + 未過期 + 動作/sessionId 吻合 + nonce 未用過。
// 成功則「消費」nonce（寫入 blacklist）並回 true；否則 res.status(...).json(...) + 回 false。
export function verifyActionToken(req, res, { action, sessionId }) {
  const tok = req.body && req.body.actionToken;
  const data = parseActionToken(tok);
  if (!data) {
    res.status(403).json({ error: 'step-up required', needStepUp: true, action, sessionId: sessionId || null });
    return false;
  }
  if (data.action !== action) {
    res.status(403).json({ error: 'action mismatch', needStepUp: true, action, sessionId: sessionId || null });
    return false;
  }
  if (!SESSIONLESS_ACTIONS.has(action) && data.sessionId !== (sessionId || null)) {
    res.status(403).json({ error: 'session mismatch', needStepUp: true, action, sessionId: sessionId || null });
    return false;
  }
  if (usedNonces.has(data.nonce)) {
    audit(req, false, 'step-up-replay', `action=${action}`);
    res.status(403).json({ error: 'token already used', needStepUp: true, action, sessionId: sessionId || null });
    return false;
  }
  usedNonces.set(data.nonce, data.exp);
  return true;
}
