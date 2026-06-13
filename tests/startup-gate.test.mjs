import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-startup-gate-'));
const port = 42000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const totpSecret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const fakeSessionId = 'local-token-autoallow-session';

fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(stateDir, 'index.json'), JSON.stringify([{
  id: fakeSessionId,
  name: 'local token autoallow fixture',
  status: 'idle',
  agentType: 'codex',
  cwd: root,
  model: null,
  autoAllow: false,
  archived: false,
  engineRefs: { claude: null, codex: null },
  lastEngine: null,
  pid: null,
  msgCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}]), 'utf8');
fs.writeFileSync(
  path.join(stateDir, 'sessions', `${fakeSessionId}.jsonl`),
  JSON.stringify({ role: 'user', text: 'fixture', ts: Date.now() }) + '\n',
  'utf8',
);

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    AHR_BIND_HOST: '127.0.0.1',
    AHR_HTTP_PORT: String(port),
    AHR_INGEST_ALIASES: '__none__',
    AHR_STATE_DIR: stateDir,
    AHR_AUTH_STATE_DIR: path.join(stateDir, 'auth'),
    AHR_USAGE_API_DISABLE: '1',
    TOTP_SECRET: totpSecret,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function fetchJsonWhenReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      return { response, json: await response.json() };
    } catch (e) {
      lastError = e;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server did not become ready: ${lastError && lastError.message}\n${logs}`);
}

async function stopChild() {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
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

function totpCode(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16)
    | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

try {
  const status = await fetchJsonWhenReady(`${base}/startup/status`);
  assert.equal(status.response.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.verified, false);
  assert.equal(status.json.action, 'startup');
  assert.equal(status.json.passkeyRequired, true);
  assert.ok(status.json.bootId);

  const dirs = await fetch(`${base}/dirs`);
  assert.equal(dirs.status, 403);
  const body = await dirs.json();
  assert.equal(body.needStartupVerification, true);
  assert.equal(body.action, 'startup');
  assert.equal(body.bootId, status.json.bootId);

  const proxiedRequest = await fetch(`${base}/local-token/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '100.64.0.1',
    },
    body: JSON.stringify({ reason: 'test' }),
  });
  assert.equal(proxiedRequest.status, 403);

  const localRequest = await fetch(`${base}/local-token/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'test orchestration' }),
  });
  assert.equal(localRequest.status, 202);
  const localRequestBody = await localRequest.json();
  assert.equal(localRequestBody.pending, true);

  const handoffBeforeMint = await fetch(`${base}/local-orchestrate/session/${fakeSessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'probe', waitMs: 0 }),
  });
  assert.equal(handoffBeforeMint.status, 403);
  const handoffBeforeMintBody = await handoffBeforeMint.json();
  assert.equal(handoffBeforeMintBody.needLocalAuthorization, true);

  const proxiedHandoff = await fetch(`${base}/local-orchestrate/session/${fakeSessionId}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '100.64.0.1',
    },
    body: JSON.stringify({ text: 'probe', waitMs: 0 }),
  });
  assert.equal(proxiedHandoff.status, 403);

  const localStepUp = await fetch(`${base}/step-up/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'mint-local-token', code: totpCode(totpSecret) }),
  });
  assert.equal(localStepUp.status, 200);
  const localStepUpBody = await localStepUp.json();
  assert.equal(localStepUpBody.ok, true);
  assert.ok(localStepUpBody.token);

  const mint = await fetch(`${base}/local-token/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionToken: localStepUpBody.token }),
  });
  assert.equal(mint.status, 200);
  const mintBody = await mint.json();
  assert.equal(mintBody.ok, true);
  assert.equal(mintBody.token, undefined);
  assert.equal(typeof mintBody.path, 'string');
  let localRecord = JSON.parse(fs.readFileSync(mintBody.path, 'utf8'));
  assert.equal(typeof localRecord.token, 'string');

  const pendingAfterMint = await fetch(`${base}/local-token/request/pending`, {
    headers: { 'X-AHR-Local-Token': localRecord.token },
  });
  assert.equal(pendingAfterMint.status, 200);
  assert.equal((await pendingAfterMint.json()).pending, true);

  const clearPending = await fetch(`${base}/local-token/request/clear`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AHR-Local-Token': localRecord.token,
    },
    body: '{}',
  });
  assert.equal(clearPending.status, 200);

  const pendingAfterClear = await fetch(`${base}/local-token/request/pending`, {
    headers: { 'X-AHR-Local-Token': localRecord.token },
  });
  assert.equal(pendingAfterClear.status, 200);
  assert.equal((await pendingAfterClear.json()).pending, false);

  const localDirs = await fetch(`${base}/dirs`, {
    headers: { 'X-AHR-Local-Token': localRecord.token },
  });
  assert.equal(localDirs.status, 200);

  const handoffAfterExistingMint = await fetch(`${base}/local-orchestrate/session/${fakeSessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waitMs: 0 }),
  });
  assert.equal(handoffAfterExistingMint.status, 403);
  const handoffAfterExistingMintBody = await handoffAfterExistingMint.json();
  assert.equal(handoffAfterExistingMintBody.needLocalAuthorization, true);

  const pendingHandoff = fetch(`${base}/local-orchestrate/session/${fakeSessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waitMs: 5000 }),
  });
  await new Promise(resolve => setTimeout(resolve, 50));

  const freshLocalStepUp = await fetch(`${base}/step-up/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'mint-local-token', code: totpCode(totpSecret) }),
  });
  assert.equal(freshLocalStepUp.status, 200);
  const freshLocalStepUpBody = await freshLocalStepUp.json();
  assert.equal(freshLocalStepUpBody.ok, true);
  assert.ok(freshLocalStepUpBody.token);

  const freshMint = await fetch(`${base}/local-token/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionToken: freshLocalStepUpBody.token }),
  });
  assert.equal(freshMint.status, 200);
  const freshMintBody = await freshMint.json();
  assert.equal(freshMintBody.ok, true);
  localRecord = JSON.parse(fs.readFileSync(freshMintBody.path, 'utf8'));
  assert.equal(typeof localRecord.token, 'string');

  const handoffAfterFreshMint = await pendingHandoff;
  assert.equal(handoffAfterFreshMint.status, 400);
  assert.equal((await handoffAfterFreshMint.json()).error, 'text or files required');

  const proxiedLocalDirs = await fetch(`${base}/dirs`, {
    headers: {
      'X-AHR-Local-Token': localRecord.token,
      'X-Forwarded-For': '100.64.0.1',
    },
  });
  assert.equal(proxiedLocalDirs.status, 403);

  const localStatus = await fetch(`${base}/local-token/status`, {
    headers: { 'X-AHR-Local-Token': localRecord.token },
  });
  assert.equal(localStatus.status, 200);
  assert.equal((await localStatus.json()).active, true);

  const autoOn = await fetch(`${base}/session/${fakeSessionId}/autoallow`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AHR-Local-Token': localRecord.token,
    },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(autoOn.status, 200);
  assert.equal((await autoOn.json()).autoAllow, true);

  const revoke = await fetch(`${base}/local-token/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AHR-Local-Token': localRecord.token,
    },
    body: '{}',
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).revoked, true);

  const revokedDirs = await fetch(`${base}/dirs`, {
    headers: { 'X-AHR-Local-Token': localRecord.token },
  });
  assert.equal(revokedDirs.status, 403);

  const totp = await fetch(`${base}/step-up/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'startup', code: totpCode(totpSecret) }),
  });
  assert.equal(totp.status, 200);
  const totpBody = await totp.json();
  assert.equal(totpBody.ok, true);
  assert.ok(totpBody.token);

  const unlock = await fetch(`${base}/startup/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionToken: totpBody.token }),
  });
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers.get('set-cookie');
  assert.match(cookie, /ahr_startup=/);

  const unlockedDirs = await fetch(`${base}/dirs`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(unlockedDirs.status, 200);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);

  console.log('startup gate ok');
} finally {
  await stopChild();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
