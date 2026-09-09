import fs from 'node:fs';
import path from 'node:path';

// This journal is metadata only. Never spread event objects, prompts, tool
// arguments or provider error bodies into it. Run aggregates are deliberately
// separate from request observations; they must not be summed together.
export function contextMetric(meta, event) {
  const row = { version: 1, at: new Date().toISOString() };
  for (const key of ['run_id', 'session_id', 'native_session_id', 'engine', 'cwd', 'model']) {
    if (typeof meta[key] === 'string') row[key] = meta[key];
  }
  if (!['start', 'live_input', 'request_usage', 'run_usage', 'compaction'].includes(event.stage)) {
    throw new TypeError('unknown context metric stage');
  }
  row.stage = event.stage;
  for (const key of ['prompt_chars', 'bootstrap_chars', 'evidence_chars', 'evidence_omitted',
    'bridge_chars', 'input_tokens', 'cache_read_tokens', 'cache_creation_tokens',
    'output_tokens', 'request_index']) {
    if (Number.isFinite(event[key]) && event[key] >= 0) row[key] = event[key];
  }
  for (const key of ['native_resume', 'cache_read_is_subset']) {
    if (typeof event[key] === 'boolean') row[key] = event[key];
  }
  if (['claude_message', 'claude_result', 'codex_turn'].includes(event.usage_scope)) {
    row.usage_scope = event.usage_scope;
  }
  return row;
}

export function recordContextMetric(stateDir, meta, event) {
  const row = contextMetric(meta, event);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'context-metrics.jsonl'), JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
  return row;
}

export function createContextObserver(stateDir, getMeta, onError = () => {}) {
  const seen = new Set();
  let requests = 0;
  const record = event => {
    try { return recordContextMetric(stateDir, getMeta(), event); }
    catch { onError(); return null; }
  };
  return {
    record,
    observe(engine, ev, usage) {
      if (ev.type === 'system' && ev.subtype === 'compact_boundary' || ev.type === 'compacted' ||
          ev.type === 'event_msg' && ev.payload?.type === 'context_compacted') {
        record({ stage: 'compaction' });
      }
      if (!usage) return;
      if (engine === 'claude' && ev.type === 'assistant' && ev.message?.id) {
        if (seen.has(ev.message.id)) return;
        seen.add(ev.message.id);
        record({ ...usage, stage: 'request_usage', usage_scope: 'claude_message', request_index: ++requests });
      } else if (engine === 'claude' && ev.type === 'result') {
        record({ ...usage, stage: 'run_usage', usage_scope: 'claude_result' });
      } else if (engine === 'codex' && ev.type === 'turn.completed') {
        record({ ...usage, stage: 'run_usage', usage_scope: 'codex_turn' });
      }
    },
  };
}
