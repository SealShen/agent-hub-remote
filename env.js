import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadLocalEnv(filePath = path.join(__dirname, '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, name, value] = match;
    if (Object.prototype.hasOwnProperty.call(process.env, name)) continue;
    process.env[name] = value.replace(/^['"]|['"]$/g, '');
  }
}

// Parse an HTTP port from a candidate env value. Returns `fallback` (default 3334)
// whenever the value is missing or not a valid 1..65535 integer, so callers never
// end up binding NaN. Shared by server.js and auth.js to keep the port — and the
// WebAuthn origin derived from it — consistent.
export function parsePort(value, fallback = 3334) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

loadLocalEnv();
