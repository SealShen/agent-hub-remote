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

loadLocalEnv();
