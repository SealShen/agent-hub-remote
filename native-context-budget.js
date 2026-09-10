import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locate } from './task-evidence-cache.js';

// Serialized history includes UTF-8 handoff, authority/bootstrap, duplicated
// prompt events and provider metadata. 64 KB can be exceeded by a fresh 24k
// character Chinese handoff alone. Reserve a fixed 512 KB envelope, still
// including tool events and independent of session age.
export const NATIVE_HISTORY_BYTE_LIMIT = 512_000;

export async function nativeHistoryWithinBudget(session, engine, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) return false;
  async function inspect(filename) {
    const handle = await fs.open(filename, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || !before.size || before.size > NATIVE_HISTORY_BYTE_LIMIT) return false;
      const buffer = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const after = await handle.stat();
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
      const text = buffer.subarray(0, size).toString('utf8');
      if (!text.endsWith('\n')) return false;
      const rows = text.trim().split('\n').map(line => JSON.parse(line));
      if (engine === 'codex') {
        const meta = rows.filter(row => row.type === 'session_meta');
        return meta.length === 1 && meta[0].payload?.id === id;
      }
      return rows.some(row => row.sessionId === id) &&
        rows.every(row => !row.sessionId || row.sessionId === id);
    } finally { await handle.close(); }
  }
  try {
    if (session.nativePath) {
      try { if (await inspect(session.nativePath)) return true; } catch { /* Try current native identity. */ }
    }
    const root = engine === 'codex'
      ? process.env.AHR_CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions')
      : process.env.AHR_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
    const filename = await locate(path.resolve(root), id);
    return filename ? await inspect(filename) : false;
  } catch { return false; }
}
