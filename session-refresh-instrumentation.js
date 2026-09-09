import { performance } from 'node:perf_hooks';

export const SESSION_REFRESH_PHASES = Object.freeze(['directoryTraversalMs','statFingerprintMs','fileReadMs','splitJsonParseMs','reconciliationMs','sessionsMaterializationMs','httpJsonSerializationMs','websocketJsonStringifyMs']);
function blankPhases() { return Object.fromEntries(SESSION_REFRESH_PHASES.map(key => [key, 0])); }
function rssBytes() { return process.memoryUsage().rss; }

export function createSessionRefreshMetrics({ kind = 'refresh', reason = 'unknown', workspaceCount = 0 } = {}) {
  const startRssBytes = rssBytes();
  const metrics = {
    schemaVersion: 1, kind, reason: String(reason || 'unknown').slice(0, 80), startedAt: new Date().toISOString(), durationMs: 0,
    counters: { workspaceCount, rootsTraversed:0, filesScanned:0, filesParsed:0, jsonLinesParsed:0, cacheHits:0, directoryCacheHits:0, directoryCacheStaleFallbacks:0, nativeScans:0, nativeScanSkipped:0, completedResultTtlHits:0, usageNotifications:0, errors:0, nativeIoActive:0, nativeIoPeakConcurrency:0 },
    errorsByStage: {}, phases: blankPhases(), payloadBytes: { http:0, websocket:0 },
    memory: { startRssBytes, endRssBytes:startRssBytes, peakRssBytes:startRssBytes, peakRssDeltaBytes:0 },
  };
  Object.defineProperty(metrics, '_startedPerf', { value: performance.now(), writable: false });
  Object.defineProperty(metrics, '_finished', { value: false, writable: true });
  return metrics;
}

export function observeRefreshRss(metrics) {
  if (!metrics) return;
  const current = rssBytes(); metrics.memory.endRssBytes = current;
  if (current > metrics.memory.peakRssBytes) metrics.memory.peakRssBytes = current;
  metrics.memory.peakRssDeltaBytes = Math.max(0, metrics.memory.peakRssBytes - metrics.memory.startRssBytes);
}
export function measureRefreshPhase(metrics, phase, fn, { sampleRss = true } = {}) {
  if (!metrics) return fn();
  if (!Object.hasOwn(metrics.phases, phase)) throw new Error(`unknown refresh metric phase: ${phase}`);
  const started = performance.now();
  try { return fn(); } finally { metrics.phases[phase] += performance.now() - started; if (sampleRss) observeRefreshRss(metrics); }
}
export async function measureRefreshPhaseAsync(metrics, phase, fn, { sampleRss = true } = {}) {
  if (!metrics) return fn();
  if (!Object.hasOwn(metrics.phases, phase)) throw new Error(`unknown refresh metric phase: ${phase}`);
  const started = performance.now();
  try { return await fn(); } finally { metrics.phases[phase] += performance.now() - started; if (sampleRss) observeRefreshRss(metrics); }
}
export async function trackNativeIoConcurrency(metrics, fn) {
  if (!metrics) return fn();
  incrementRefreshCounter(metrics, 'nativeIoActive');
  if (metrics.counters.nativeIoActive > metrics.counters.nativeIoPeakConcurrency) metrics.counters.nativeIoPeakConcurrency = metrics.counters.nativeIoActive;
  try { return await fn(); } finally { metrics.counters.nativeIoActive -= 1; }
}
export function incrementRefreshCounter(metrics, counter, amount = 1) { if (!metrics) return; if (!Object.hasOwn(metrics.counters, counter)) metrics.counters[counter]=0; metrics.counters[counter]+=amount; }
export function recordRefreshError(metrics, stage) { if (!metrics) return; incrementRefreshCounter(metrics,'errors'); const safeStage=String(stage||'unknown').replace(/[^a-z0-9_-]/gi,'_').slice(0,60)||'unknown'; metrics.errorsByStage[safeStage]=(metrics.errorsByStage[safeStage]||0)+1; }
export function serializeRefreshJson(value, metrics, { phase='httpJsonSerializationMs', payload='http' }={}) { const json=measureRefreshPhase(metrics,phase,()=>JSON.stringify(value)); if(metrics&&Object.hasOwn(metrics.payloadBytes,payload)) metrics.payloadBytes[payload]+=Buffer.byteLength(json,'utf8'); return json; }
function rounded(value){ return Math.round(value*1000)/1000; }
export function finishSessionRefreshMetrics(metrics){ if(!metrics)return null; if(!metrics._finished){observeRefreshRss(metrics);metrics.durationMs=performance.now()-metrics._startedPerf;metrics._finished=true;} return {schemaVersion:metrics.schemaVersion,kind:metrics.kind,reason:metrics.reason,startedAt:metrics.startedAt,durationMs:rounded(metrics.durationMs),counters:{...metrics.counters},errorsByStage:{...metrics.errorsByStage},phases:Object.fromEntries(Object.entries(metrics.phases).map(([k,v])=>[k,rounded(v)])),payloadBytes:{...metrics.payloadBytes},memory:{...metrics.memory}}; }
export function logSessionRefreshMetrics(metrics, logger=console.error){ const finished=finishSessionRefreshMetrics(metrics); if(finished)logger(`[ahr-perf] ${JSON.stringify(finished)}`); return finished; }
