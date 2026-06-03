// Optional local summarizer for cross-engine bridge prompts.
// If AHR_GAMMA_DIR is not configured and no adjacent gamma-v1 checkout exists,
// AHR falls back to full transcript bridging.
import './env.js';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GAMMA_DIR = path.join(__dirname, '..', 'gamma-v1');

function hasGammaClient(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'adapters', 'lmstudio_client.js'));
}

const configuredGammaDir = process.env.AHR_GAMMA_DIR && process.env.AHR_GAMMA_DIR.trim();
const GAMMA_DIR = configuredGammaDir || (hasGammaClient(DEFAULT_GAMMA_DIR) ? DEFAULT_GAMMA_DIR : '');

function loadGammaEnv() {
  if (!GAMMA_DIR) return;
  try {
    const raw = fs.readFileSync(path.join(GAMMA_DIR, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (!m) continue;
      const [, k, v] = m;
      if (!(k in process.env)) process.env[k] = v.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // No gamma env file is fine; the client may still work from ambient env.
  }
}

loadGammaEnv();

let _chat = null;
if (GAMMA_DIR) {
  try {
    ({ chat: _chat } = require(path.join(GAMMA_DIR, 'adapters', 'lmstudio_client.js')));
  } catch (e) {
    console.error(`[agent-hub-remote] gemma client unavailable (AHR_GAMMA_DIR=${GAMMA_DIR}); bridge summaries disabled:`, e.message);
  }
}

const SUMMARIZE_SYSTEM =
  'Summarize this cross-engine conversation for continuing work. ' +
  'Keep actionable project context, current goal, important constraints, file paths, commands, and validation state. ' +
  'Use 120-260 words. Do not include hidden reasoning or unrelated commentary.';

export async function summarize(transcript) {
  if (!_chat || !transcript || !transcript.trim()) return null;
  try {
    const res = await _chat({
      prompt: transcript,
      systemPrompt: SUMMARIZE_SYSTEM,
      temperature: 0.3,
      maxTokens: 1024,
      timeout: 45000,
    });
    if (res && res.ok && res.content && res.content.trim()) return res.content.trim();
    return null;
  } catch {
    return null;
  }
}
