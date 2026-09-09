import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildCompactTranscript } from './compact-context.js';

export const BRIDGE_CONTEXT_LIMIT = 24_000;
export const BRIDGE_SNAPSHOT_LIMIT = 10_000_000;

// The snapshot preserves the supplied fullText exactly. No model request or
// deletion occurs here; callers must supply their complete projected history.
export function buildBridgeContext({ messages, fullText, stateDir, requireComplete = false }) {
  if (typeof fullText !== 'string') throw new TypeError('bridge fullText must be a string');
  if (fullText.length <= BRIDGE_CONTEXT_LIMIT) {
    return { text: fullText, chars: fullText.length, omitted: false };
  }
  if (requireComplete) {
    throw new RangeError('Automatic rollover blocked: complete conversation exceeds the 24000-character handoff budget. Review and confirm compact continuation context before retrying; no partial history was sent.');
  }
  if (fullText.length > BRIDGE_SNAPSHOT_LIMIT) {
    throw new RangeError('Bridge history exceeds snapshot limit; compact the session before switching engines.');
  }
  const directory = path.resolve(stateDir, 'context-artifacts');
  const filePath = path.join(directory, `${randomUUID()}.txt`);
  const sha256 = createHash('sha256').update(fullText, 'utf8').digest('hex');
  const header = `Partial cross-engine history follows. Earlier messages or message middles may be omitted; retrieve the snapshot when needed before relying on missing decisions or constraints.\nFull supplied history snapshot: ${filePath}\nSHA-256 (UTF-8): ${sha256}\n\n`;
  const excerpt = buildCompactTranscript(messages, BRIDGE_CONTEXT_LIMIT - header.length);
  if (!excerpt) throw new Error('Cannot build a bridge excerpt from empty messages; compact the session before switching engines.');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filePath, fullText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const text = header + excerpt;
  return { text, chars: text.length, artifact: { path: filePath, sha256, chars: fullText.length }, omitted: true };
}
