import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate state so importing store.js (transitively via engines.js) is harmless.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-resume-fallback-'));
process.env.AHR_STATE_DIR = path.join(root, 'state');

const { continuationPlan } = await import('../engines.js');

function sess(over = {}) {
  return {
    lastEngine: 'claude',
    engineRefs: { claude: 'native-id', codex: null },
    _resumeFailed: false,
    ...over,
  };
}

try {
  // 1) 同引擎 + 有指標 + 未失敗 → 原生 resume，不 bridge、不 gate
  assert.deepEqual(
    continuationPlan(sess(), { engine: 'claude', hasHistory: true }),
    { resume: true, forceBridge: false, gate: false },
    'healthy same-engine → native resume',
  );

  // 2) resume 曾失敗 + 未同意 → gate（阻擋徵詢），不得開新
  assert.deepEqual(
    continuationPlan(sess({ _resumeFailed: true }), { engine: 'claude', hasHistory: true }),
    { resume: false, forceBridge: false, gate: true },
    'resume failed, no consent → gate',
  );

  // 3) resume 曾失敗 + 已同意 → forceBridge（用前文接續），不 gate
  assert.deepEqual(
    continuationPlan(sess({ _resumeFailed: true }), { engine: 'claude', hasHistory: true, confirmBridge: true }),
    { resume: false, forceBridge: true, gate: false },
    'resume failed + consent → bridge',
  );

  // 4) 良性無指標（如 codex 中斷後）+ 有前文 → 自動 bridge，不 gate（非失敗）
  assert.deepEqual(
    continuationPlan(sess({ engineRefs: { claude: null, codex: null } }), { engine: 'claude', hasHistory: true }),
    { resume: false, forceBridge: true, gate: false },
    'benign missing pointer + history → auto bridge',
  );

  // 5) 無前文（真‧新對話）→ 全 false，允許開新
  assert.deepEqual(
    continuationPlan(sess({ engineRefs: { claude: null, codex: null } }), { engine: 'claude', hasHistory: false }),
    { resume: false, forceBridge: false, gate: false },
    'no history → allow fresh',
  );

  // 6) pendingContext（rewind/compact）→ 全 false，交既有分支處理
  assert.deepEqual(
    continuationPlan(sess({ _resumeFailed: true }), { engine: 'claude', hasHistory: true, pendingContext: true }),
    { resume: false, forceBridge: false, gate: false },
    'pendingContext bypasses gate',
  );

  // 7) 跨引擎（lastEngine≠engine）→ 全 false，交跨引擎 bridge 分支
  assert.deepEqual(
    continuationPlan(sess({ lastEngine: 'codex' }), { engine: 'claude', hasHistory: true }),
    { resume: false, forceBridge: false, gate: false },
    'cross-engine bypasses same-engine logic',
  );

  // 8) 跨引擎一致：codex 走完全相同的判定（無特例）。
  //    對每個情境，把 engine 換成 codex + 對應指標，結果必須與 claude 逐項相同。
  const codexSess = (over = {}) => sess({ lastEngine: 'codex', engineRefs: { claude: null, codex: 'cx-thread' }, ...over });
  assert.deepEqual(
    continuationPlan(codexSess(), { engine: 'codex', hasHistory: true }),
    continuationPlan(sess(), { engine: 'claude', hasHistory: true }),
    'codex healthy resume == claude',
  );
  assert.deepEqual(
    continuationPlan(codexSess({ _resumeFailed: true }), { engine: 'codex', hasHistory: true }),
    continuationPlan(sess({ _resumeFailed: true }), { engine: 'claude', hasHistory: true }),
    'codex resume-failed gate == claude',
  );
  assert.deepEqual(
    continuationPlan(codexSess({ _resumeFailed: true }), { engine: 'codex', hasHistory: true, confirmBridge: true }),
    continuationPlan(sess({ _resumeFailed: true }), { engine: 'claude', hasHistory: true, confirmBridge: true }),
    'codex consented bridge == claude',
  );
  // 取消後保留指標（無 codex 特例）→ 下一輪同 claude 一樣可原生 resume
  assert.deepEqual(
    continuationPlan(codexSess(), { engine: 'codex', hasHistory: true }),
    { resume: true, forceBridge: false, gate: false },
    'codex post-cancel (pointer kept) → native resume, no special-case',
  );

  console.log('resume fallback continuationPlan matrix + cross-engine parity ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
