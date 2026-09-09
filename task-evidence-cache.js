import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const LIMIT = 32 * 1024 * 1024;
const locations = new Map();
const observations = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > 64) map.delete(map.keys().next().value);
}

export async function locate(root, id) {
  const key = `${root}\0${id}`;
  if (locations.has(key)) return locations.get(key);
  const matches = [];
  let count = 0;
  async function visit(dir, depth) {
    if (depth > 4) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    count += entries.length;
    if (count > 10000) throw new Error('discovery budget exceeded');
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`)) matches.push(target);
    }
  }
  await visit(root, 0);
  if (matches.length !== 1) return null;
  boundedSet(locations, key, matches[0]);
  return matches[0];
}

async function observe(filename, id) {
  if (!filename || path.extname(filename) !== '.jsonl') return null;
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > LIMIT) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
    const text = buffer.toString('utf8');
    if (!text.endsWith('\n')) return null; // A partial event cannot establish a safe epoch.
    const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const metadata = rows.filter(row => row.type === 'session_meta');
    if (metadata.length !== 1 || metadata[0]?.payload?.id !== id) return null;
    const compact = rows.filter(row => row.type === 'compacted' ||
      (row.type === 'event_msg' && row.payload?.type === 'context_compacted'));
    const identity = `${filename}\0${stat.dev}\0${stat.ino}\0${stat.birthtimeMs}\0${id}`;
    const previous = observations.get(identity);
    const extendsPrevious = previous && buffer.length >= previous.size &&
      hash(buffer.subarray(0, previous.size)) === previous.digest;
    const generation = extendsPrevious ? previous.generation : randomUUID();
    boundedSet(observations, identity, { size: buffer.length, digest: hash(buffer), generation });
    return hash(`${identity}\0${generation}\0${JSON.stringify(compact)}`);
  } finally { await handle.close(); }
}

// Read only a verified Codex transcript. Failure means inject again, never assume retention.
export async function evidenceContextEpoch(session, engine, nativeResumeId) {
  if (engine !== 'codex' || typeof nativeResumeId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(nativeResumeId)) return null;
  try {
    if (session?.nativePath) {
      try {
        const direct = await observe(session.nativePath, nativeResumeId);
        if (direct) return direct;
      } catch { /* Fall through to bounded native discovery. */ }
    }
    const root = path.resolve(process.env.AHR_CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions'));
    const filename = await locate(root, nativeResumeId);
    return filename ? await observe(filename, nativeResumeId) : null;
  } catch { return null; }
}

export function filterEvidenceFiles(files, { epoch = null, cache = null } = {}) {
  const previous = new Set(epoch && cache?.epoch === epoch && Array.isArray(cache.keys) ? cache.keys : []);
  const seen = new Set(previous);
  const selected = [];
  for (const file of files) {
    const key = hash(JSON.stringify([path.resolve(file.path), file.sha256, file.excerpt]));
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(file);
  }
  return { files: selected, omittedCount: files.length - selected.length,
    nextCache: epoch ? { epoch, keys: [...seen].slice(-512) } : null };
}
