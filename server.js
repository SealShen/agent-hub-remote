// agent-hub-remote public server.
// Bind loopback and expose it through Tailscale Serve inside a private tailnet.
// Implements the structured route protocol used by the browser UI.

import { parsePort } from './env.js';
import express from 'express';
import http from 'http';
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import writeFileAtomic from 'write-file-atomic';

import {
  assertSecret, rejectFunnel, handleStepUpTotp, verifyActionToken, audit,
  handlePasskeyStatus, handleEnrollPasskeyStart, handleEnrollPasskeyFinish,
  handleStepUpPasskeyStart, handleStepUpPasskeyFinish,
  handleStartupStatus, handleStartupUnlock, requireStartupVerified,
  verifyStartupCookie,
  verifyLocalToken, handleLocalTokenMint, handleLocalTokenStatus, handleLocalTokenRevoke,
  isLocalLoopbackRequest, getLocalTokenStatus, waitForLocalToken,
} from './auth.js';
import {
  sessions, hydrate, createSession, sessionsArr, loadMessages,
  appendMsg, persistIndex, applyRetention, ingestProjects,
  appendContextControl, syncMessageCount, pendingContextFromControls,
  queuedInputs, allQueuedInputs, enqueueInput, dequeueInput, requeueInput,
  removeQueuedInput, clearQueuedInputs, QUEUE_LIMIT,
} from './store.js';
import {
  runEngine, killTree, canAcceptLiveInput, writeLiveInput, continuationPlan,
  normalizedEffortArg, cancelAutoResume, armPersistedAutoResumes, setTurnEndHook,
  normalizedModelArg, CLAUDE_DEFAULT_MODEL, verifyClaudeAuth,
} from './engines.js';
import { spawnCli } from './cli-launch.js';
import { startRelogin, submitReloginCode, reloginStatus, cancelRelogin } from './auth-relogin.js';
import { projectContextMessages } from './context-projection.js';
import { rewindTranscriptFallback } from './rewind-context.js';
import { buildCompactTranscript, compactPrompt } from './compact-context.js';
import {
  createSessionRefreshMetrics,
  incrementRefreshCounter,
  logSessionRefreshMetrics,
  recordRefreshError,
  serializeRefreshJson,
} from './session-refresh-instrumentation.js';
import {
  formatTurnUsageLine,
  getUsage,
  normalizeClaudeTurnUsage,
  normalizeCodexTurnUsage,
  readLatestUsageEntry,
  startUsageApiPoller,
  usageEntryKey,
} from './usage-core.js';
import { titleSnippetFromText } from './title-cleanup.js';
import { createRefreshCoordinator } from './refresh-coordinator.js';
import { FileDownloadError, resolveSessionDownload } from './file-download.js';
import { previewDispositionFor, resolveUploadDownload } from './upload-store.js';
import { findHarnessDir, readHarnessReviewState, verifyHarnessReviewProvenance } from './harness-outcomes.js';

assertSecret();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = parsePort(process.env.AHR_HTTP_PORT || process.env.AHR_PORT || process.env.AGENT_HUB_PORT);
const BIND_HOST = process.env.AHR_BIND_HOST || '127.0.0.1';
const DISABLE_ENGINE_RUN = process.env.AHR_DISABLE_ENGINE_RUN === '1';
const parsedSessionRefreshTtlMs = Number.parseInt(process.env.AHR_SESSION_REFRESH_TTL_MS || '', 10);
const SESSION_REFRESH_TTL_MS = Number.isFinite(parsedSessionRefreshTtlMs) && parsedSessionRefreshTtlMs >= 0
  ? parsedSessionRefreshTtlMs
  : 30_000;
const parsedSessionRefreshTimeoutMs = Number.parseInt(process.env.AHR_SESSION_REFRESH_TIMEOUT_MS || '', 10);
const SESSION_REFRESH_TIMEOUT_MS = Number.isFinite(parsedSessionRefreshTimeoutMs) && parsedSessionRefreshTimeoutMs > 0
  ? parsedSessionRefreshTimeoutMs
  : 20_000;
const STATE_DIR = process.env.AHR_STATE_DIR
  ? path.resolve(process.env.AHR_STATE_DIR)
  : path.join(__dirname, '.state');
const REMINDERS_PATH = path.join(STATE_DIR, 'reminders.json');

function loadDirs() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, 'dirs.json'), 'utf8'));
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  const env = process.env.ALLOWED_DIRS;
  if (env && env.trim()) {
    const out = [];
    for (const part of env.split(';')) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      out.push({ alias: part.slice(0, i).trim(), path: part.slice(i + 1).trim() });
    }
    if (out.length) return out;
  }
  return [{ alias: 'home', path: HOME, label: 'home' }];
}
const DIRS = loadDirs();
const DIR_BY_ALIAS = new Map(DIRS.map(d => [d.alias, d]));
const CLAUDE_MODELS = new Set(['claude-sonnet-5', 'sonnet', 'opus', 'haiku']);
const CODEX_UNSUPPORTED_MODELS = new Set(['gpt-5-codex']);

function codexModelArg(model) {
  const raw = model && model !== 'default' ? String(model) : null;
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (CLAUDE_MODELS.has(lower) || /^claude-/i.test(raw)) return null;
  if (CODEX_UNSUPPORTED_MODELS.has(lower)) return null;
  return raw;
}

function resolveCwd(alias) {
  const d = DIR_BY_ALIAS.get(alias);
  return d ? path.resolve(d.path) : null;
}

function isLinkedGitWorktree(cwd) {
  if (!cwd) return false;
  try { return fs.statSync(path.join(cwd, '.git')).isFile(); } catch { return false; }
}

function codexWriteGuard(agentType, cwd, autoAllow) {
  if (agentType !== 'codex' || !autoAllow) return null;
  return null;
}

function allowAutoModeAction(req, res, action, sessionId) {
  if (verifyLocalToken(req)) return true;
  return verifyActionToken(req, res, { action, sessionId });
}

const uploadTtlRaw = parseInt(process.env.AHR_UPLOAD_TTL_MS || `${24 * 60 * 60 * 1000}`, 10);
const UPLOAD_TTL_MS = Number.isFinite(uploadTtlRaw) ? Math.max(60_000, uploadTtlRaw) : 24 * 60 * 60 * 1000;
const AHR_MEDIA_DIR = path.join(os.tmpdir(), 'agent-hub-remote', 'uploads');
try { fs.mkdirSync(AHR_MEDIA_DIR, { recursive: true }); } catch {}

function cleanupExpiredUploads() {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  const queuedPaths = new Set();
  for (const item of allQueuedInputs()) {
    for (const file of Array.isArray(item?.files) ? item.files : []) {
      if (file && typeof file.path === 'string') queuedPaths.add(path.resolve(file.path));
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(AHR_MEDIA_DIR, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = path.join(AHR_MEDIA_DIR, entry.name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff && !queuedPaths.has(path.resolve(p))) fs.unlinkSync(p);
    } catch {}
  }
}
setInterval(cleanupExpiredUploads, Math.min(60 * 60 * 1000, UPLOAD_TTL_MS)).unref();

function sanitizeUploadName(filename) {
  const base = path.basename(String(filename || 'attachment.bin'));
  const safe = base.replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, '_').slice(0, 80);
  return safe || 'attachment.bin';
}

function isStoredUpload(p) {
  if (!p || typeof p !== 'string') return false;
  const root = path.resolve(AHR_MEDIA_DIR) + path.sep;
  const resolved = path.resolve(p);
  return resolved === path.resolve(AHR_MEDIA_DIR) || resolved.startsWith(root);
}

function normalizeAttachedFile(f) {
  if (!f) return null;
  const filePath = typeof f === 'string' ? f : f.path;
  if (!isStoredUpload(filePath)) return null;
  return {
    path: path.resolve(filePath),
    id: path.basename(path.resolve(filePath)),
    name: typeof f === 'object' && f.name ? String(f.name).slice(0, 160) : path.basename(filePath),
    type: typeof f === 'object' && f.type ? String(f.type).slice(0, 120) : '',
    size: typeof f === 'object' && Number.isFinite(f.size) ? f.size : null,
  };
}

function publicAttachment(f) { return { id: f.id, name: f.name, type: f.type, size: f.size }; }
function attachedFilesFrom(body) {
  const { files, imagePaths } = body || {};
  return [...(Array.isArray(files) ? files : []), ...(Array.isArray(imagePaths) ? imagePaths : [])]
    .map(normalizeAttachedFile).filter(Boolean);
}
function attachmentPromptSection(attachments) {
  if (!attachments.length) return '';
  return '\n\nAttached local files are available for this turn. Use the Read tool or shell commands to inspect them before answering when relevant:\n'
    + attachments.map(f => {
      const details = [f.name, f.type, f.size != null ? `${f.size} bytes` : null].filter(Boolean).join(', ');
      return `- ${f.path}${details ? ` (${details})` : ''}`;
    }).join('\n');
}
function attachmentDisplayText(text, attachments) {
  return String(text || '') + (attachments.length ? `\n[files: ${attachments.length}]` : '');
}

const COMPACT_INPUT_LIMIT = 25_000;
const REWIND_INLINE_LIMIT = 6_000;
function conversationMessages(messages) {
  return projectContextMessages(messages).filter(m => (m.role === 'user' || m.role === 'assistant') && m.text && String(m.text).trim());
}
function userTurnIndices(messages) {
  const idx = [];
  messages.forEach((m, i) => { if (m.role === 'user' && m.text && String(m.text).trim()) idx.push(i); });
  return idx;
}
function conversationText(messages, maxChars = COMPACT_INPUT_LIMIT) {
  let out = '';
  for (const m of conversationMessages(messages)) {
    const tag = m.role === 'user' ? 'User' : 'Assistant';
    const body = String(m.text).length > 2000 ? String(m.text).slice(0, 2000) + '...[truncated]' : String(m.text);
    out += `${tag}: ${body}\n\n`;
    if (out.length > maxChars) return out.slice(0, maxChars);
  }
  return out.trim();
}
function cleanupClaudePrintSession(tempSessionId) {
  const root = path.join(HOME, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try { fs.unlinkSync(path.join(root, d.name, tempSessionId + '.jsonl')); } catch {}
  }
}
function runClaudeSummary(transcript, cwd, model) {
  return new Promise((resolve) => {
    const tempSessionId = crypto.randomUUID();
    const args = ['--print', '--no-session-persistence', '--session-id', tempSessionId];
    const modelArg = model && model !== 'default' && !/^gpt-/i.test(model) ? model : null;
    if (modelArg) args.push('--model', modelArg);
    const env = { ...process.env }; delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY;
    let proc;
    try { proc = spawnCli('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env }); } catch { return resolve(null); }
    let output = '', stderr = '', settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); cleanupClaudePrintSession(tempSessionId); resolve(value); };
    const timer = setTimeout(() => { try { killTree(proc); } catch {} finish(null); }, 10_000);
    proc.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-1000); });
    proc.on('error', () => finish(null));
    proc.on('close', code => { if (code === 0 && output.trim()) return finish(output.trim()); finish(null); });
    proc.stdin.write(compactPrompt(transcript), 'utf8'); proc.stdin.end();
  });
}
function codexSummaryText(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') return String(ev.item.text || '').trim();
  if (ev.type === 'agent_message') return String(ev.text || '').trim();
  if (ev.type === 'turn.completed' && typeof ev.output === 'string') return ev.output.trim();
  return '';
}
function runCodexSummary(transcript, cwd, model) {
  return new Promise((resolve) => {
    const args = ['exec', '-s', 'read-only', '--json', '--skip-git-repo-check'];
    const modelArg = codexModelArg(model); if (modelArg) args.push('-m', modelArg);
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
    let proc; try { proc = spawnCli('codex', args, { cwd, stdio: ['pipe','pipe','pipe'], env }); } catch { return resolve(null); }
    let buf='', output='', settled=false;
    const finish=v=>{ if(settled)return; settled=true; clearTimeout(timer); resolve(v&&v.trim()?v.trim():null); };
    const timer=setTimeout(()=>{ try{killTree(proc);}catch{} finish(null); },45_000);
    proc.stdout.on('data', chunk=>{ buf+=chunk.toString('utf8'); const lines=buf.split('\n'); buf=lines.pop(); for(const line of lines){ if(!line.trim())continue; try{ const text=codexSummaryText(JSON.parse(line)); if(text)output+=(output?'\n':'')+text; }catch{ output+=(output?'\n':'')+line.trim(); } } });
    proc.on('error',()=>finish(null));
    proc.on('close', code=>{ if(buf.trim()){ try{ const text=codexSummaryText(JSON.parse(buf)); if(text)output+=(output?'\n':'')+text; }catch{ output+=(output?'\n':'')+buf.trim(); } } if(code===0&&output.trim())return finish(output.trim()); finish(null); });
    proc.stdin.write(compactPrompt(transcript),'utf8'); proc.stdin.end();
  });
}
async function summarizeForSession(transcript,s){ if(s.agentType==='codex'){ const x=await runCodexSummary(transcript,s.cwd,s.model); if(x)return x; return null; } const x=await runClaudeSummary(transcript,s.cwd,s.model); if(x)return x; return null; }
async function contextForTranscript(transcript,s,{inlineLimit=REWIND_INLINE_LIMIT,label='rewind',fallbackContext=null}={}){ if(!transcript)return{context:'',mode:'cleared'}; if(inlineLimit>0&&transcript.length<=inlineLimit)return{context:transcript,mode:'transcript'}; const summary=await summarizeForSession(transcript,s); if(summary)return{context:summary,mode:'summary'}; const fallback=fallbackContext==null?rewindTranscriptFallback(transcript):{context:fallbackContext,mode:'transcript'}; return fallback; }
async function contextForMessages(messages,s){ return contextForTranscript(conversationText(messages),s); }
function sessionPayload(s){ return sessionsArr().find(m=>m.id===s.id)||null; }
function actionPayload(s){ return {ok:true,session:sessionPayload(s),messages:loadMessages(s.id,0)}; }
function engineRefsSnapshot(s){ return {claude:s.engineRefs?.claude||null,codex:s.engineRefs?.codex||null}; }
function contextResetMeta(s,{op,turn}={}){ return {op:op||'reset',turn:turn??null,ts:Date.now(),agentType:s.agentType==='codex'?'codex':'claude',lastEngine:s.lastEngine||null,previousEngineRefs:engineRefsSnapshot(s)}; }
function applyContextReset(s,pending,resetMeta){ cancelAutoResume(s,{persist:false}); s._limitAttempts=0; s.pendingContext={...pending,contextReset:resetMeta||pending.contextReset||null,freshThread:true}; s.contextReset=resetMeta||null; s.engineRefs={claude:null,codex:null}; s.lastEngine=null; s.pid=null; s.cancelled=false; s.status='idle'; s.archived=false; syncMessageCount(s); applyRetention(); persistIndex(); }

let startupOrphans=[];
function recoverInterruptedSessions(){ startupOrphans=hydrate(); for(const {id,pid} of startupOrphans){ if(process.platform==='win32'){ try{ spawn('taskkill',['/pid',String(pid),'/T','/F'],{windowsHide:true}); }catch{} } else { try{process.kill(pid,'SIGKILL');}catch{} } } }
const INGEST_ALIASES=(process.env.AHR_INGEST_ALIASES?process.env.AHR_INGEST_ALIASES.split(',').map(s=>s.trim()).filter(Boolean):DIRS.map(d=>d.alias));
let lastSuccessfulNativeRefreshAt=null;
async function refreshNativeSessions(reason='api',{force=false}={}){ const cwds=INGEST_ALIASES.map(a=>resolveCwd(a)).filter(Boolean); const metrics=createSessionRefreshMetrics({reason,workspaceCount:cwds.length}); const now=Date.now(); if(!force&&SESSION_REFRESH_TTL_MS>0&&lastSuccessfulNativeRefreshAt!=null&&now-lastSuccessfulNativeRefreshAt<SESSION_REFRESH_TTL_MS){ incrementRefreshCounter(metrics,'nativeScanSkipped'); incrementRefreshCounter(metrics,'completedResultTtlHits'); const data=sessionsArr(metrics); const result={ok:true,added:0,sessions:data,refreshedAt:lastSuccessfulNativeRefreshAt,cached:true,completed:true}; Object.defineProperty(result,'metrics',{value:metrics}); return result; } try{ const added=await ingestProjects(cwds,metrics,{forceProjectDiscovery:force}); const data=sessionsArr(metrics); const completed=metrics.counters.errors===0; const refreshedAt=Date.now(); if(completed)lastSuccessfulNativeRefreshAt=refreshedAt; const result={ok:true,added,sessions:data,refreshedAt,cached:false,completed}; Object.defineProperty(result,'metrics',{value:metrics}); return result; }catch(e){ recordRefreshError(metrics,'refresh'); const result={ok:false,error:e.message}; Object.defineProperty(result,'metrics',{value:metrics}); return result; } }
const nativeRefreshCoordinator=createRefreshCoordinator((reason,force)=>refreshNativeSessions(reason,{force}));
const REFRESH_TIMEOUT_SENTINEL=Symbol('refresh-timeout');
function refreshWithResponseTimeout(promise,ms){ let timer; const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(REFRESH_TIMEOUT_SENTINEL),ms);}); return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer)); }
const observedRefreshPromises=new WeakSet();
function observeRefreshCompletion(promise){ if(observedRefreshPromises.has(promise))return; observedRefreshPromises.add(promise); promise.then(result=>{ if(result&&result.ok)broadcast({type:'sessions',data:result.sessions},result.metrics); if(result)logSessionRefreshMetrics(result.metrics); }).catch(()=>{}); }

const app=express();
app.use(rejectFunnel);
app.use(express.json({limit:'12mb'}));
const server=http.createServer(app); const wss=new WebSocketServer({noServer:true});
let pendingLocalTokenRequest=null; let pendingLocalOrchestrateApproval=null;
const NEW_SESSION_REQUEST_TTL_MS=10*60*1000; const newSessionRequests=new Map();
function normalizeClientRequestId(raw){ if(typeof raw!=='string')return''; const value=raw.trim(); return /^[A-Za-z0-9._:-]{8,128}$/.test(value)?value:''; }
function cleanupNewSessionRequests(now=Date.now()){ for(const [id,rec] of newSessionRequests){ if(!rec||now-rec.createdAt>NEW_SESSION_REQUEST_TTL_MS)newSessionRequests.delete(id); } }
function newSessionFingerprint({text,cwd,agentType,model,effort,autoAllow,files}){ return JSON.stringify([String(text||'').trim(),path.resolve(cwd),agentType,model||null,effort||null,!!autoAllow,(Array.isArray(files)?files:[]).map(f=>f.path)]); }
function findExistingNewSession(clientRequestId,fingerprint){ if(!clientRequestId)return null; cleanupNewSessionRequests(); const rec=newSessionRequests.get(clientRequestId); if(!rec)return null; if(rec.fingerprint!==fingerprint)return{error:'clientRequestId already used with different session payload'}; if(!sessions.has(rec.sessionId)){newSessionRequests.delete(clientRequestId);return null;} return{sessionId:rec.sessionId}; }
function rememberNewSessionRequest(clientRequestId,fingerprint,sessionId){ if(!clientRequestId)return; cleanupNewSessionRequests(); newSessionRequests.set(clientRequestId,{fingerprint,sessionId,createdAt:Date.now()}); }
server.on('upgrade',(req,socket,head)=>{ if(req.headers['tailscale-funnel-request']){socket.destroy();return;} if(!verifyStartupCookie(req)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;} wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req)); });
function broadcast(obj,metrics=null){ const data=metrics?serializeRefreshJson(obj,metrics,{phase:'websocketJsonStringifyMs',payload:'websocket'}):JSON.stringify(obj); for(const ws of wss.clients){ if(ws.readyState===1)ws.send(data); } }
function sendMeasuredJson(res,value,metrics){ const data=serializeRefreshJson(value,metrics,{phase:'httpJsonSerializationMs',payload:'http'}); res.type('application/json').send(data); }
function loadReminders(){ try{const parsed=JSON.parse(fs.readFileSync(REMINDERS_PATH,'utf8')); if(Array.isArray(parsed))return parsed; if(parsed&&Array.isArray(parsed.reminders))return parsed.reminders;}catch{} return[]; }
function saveReminders(reminders){ try{fs.mkdirSync(STATE_DIR,{recursive:true});writeFileAtomic.sync(REMINDERS_PATH,JSON.stringify({reminders},null,2)+'\n',{encoding:'utf8'});}catch{} }
function reminderDue(reminder,nowMs=Date.now()){ if(!reminder||reminder.deliveredAt)return false; const due=Date.parse(reminder.dueAt); return Number.isFinite(due)&&due<=nowMs; }
function sendReminder(ws,reminder){ if(!ws||ws.readyState!==1)return false; try{ws.send(JSON.stringify({type:'reminder',id:reminder.id,text:reminder.text||'',dueAt:reminder.dueAt||null}));return true;}catch{return false;} }
function deliverDueReminders(){ const reminders=loadReminders(); let changed=false; for(const reminder of reminders){ if(!reminderDue(reminder))continue; let delivered=false; for(const ws of wss.clients){ if(sendReminder(ws,reminder))delivered=true; } if(delivered){reminder.deliveredAt=new Date().toISOString();changed=true;} } if(changed)saveReminders(reminders); }
function setPendingLocalTokenRequest(reason){pendingLocalTokenRequest={reason,requestedAt:Date.now()};broadcast({type:'local_token_request',...pendingLocalTokenRequest});}
function getPendingLocalTokenRequest(){return pendingLocalTokenRequest;}
wss.on('connection',(ws)=>{ const metrics=createSessionRefreshMetrics({kind:'delivery',reason:'websocket-connect'}); const payload={type:'sessions',data:sessionsArr(metrics)}; ws.send(serializeRefreshJson(payload,metrics,{phase:'websocketJsonStringifyMs',payload:'websocket'})); logSessionRefreshMetrics(metrics); deliverDueReminders(); });

function sameResolvedPath(a,b){ if(!a||!b)return false; try{return path.resolve(String(a)).toLowerCase()===path.resolve(String(b)).toLowerCase();}catch{return false;} }
function usageEntryFromBody(body){ if(!body||typeof body!=='object'||!Object.keys(body).length)return null; const engine=String(body.engine||body.source||'claude').toLowerCase()==='codex'?'codex':'claude'; const raw=body.usage&&typeof body.usage==='object'?body.usage:body; const meta={logged_at:body.logged_at,turn_ts:body.turn_ts||body.timestamp,session_id:body.session_id,native_session_id:body.native_session_id||body.session_id,cwd:body.cwd,model:body.model}; const entry=engine==='codex'?normalizeCodexTurnUsage(raw,meta):normalizeClaudeTurnUsage(raw,meta); if(entry&&body.transcript_path)entry.transcript_path=String(body.transcript_path); return entry; }
function matchingUsageSession(entry){ if(!entry||typeof entry!=='object')return null; const engine=entry.engine==='codex'?'codex':'claude'; const ids=new Set([entry.session_id,entry.native_session_id].filter(Boolean).map(String)); if(entry.transcript_path){for(const s of sessions.values()){if(s.agentType===engine&&sameResolvedPath(s.nativePath,entry.transcript_path))return s;}} if(ids.size){for(const s of sessions.values()){if(s.agentType!==engine)continue; const nativeId=engine==='codex'?s.engineRefs?.codex:s.engineRefs?.claude; if(ids.has(String(s.id))||(nativeId&&ids.has(String(nativeId))))return s;}} const cwd=entry.cwd?path.resolve(String(entry.cwd)).toLowerCase():''; if(!cwd)return null; return [...sessions.values()].filter(s=>s.agentType===engine&&s.cwd&&path.resolve(s.cwd).toLowerCase()===cwd).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0]||null; }
function appendUsageNotification(entry){ if(!entry)return{appended:false,reason:'no_usage'}; const s=matchingUsageSession(entry); if(!s)return{appended:false,reason:'no_session'}; const turnText=formatTurnUsageLine(entry); if(!turnText)return{appended:false,reason:'no_text',sessionId:s.id}; const key=usageEntryKey(entry); if(key&&loadMessages(s.id,0).some(m=>m.kind==='usage'&&m.usageKey===key))return{appended:false,duplicate:true,sessionId:s.id}; const text=`Usage: ${turnText}`; const ts=appendMsg(s,{role:'system',kind:'usage',engine:entry.engine,text,usageKey:key}); broadcast({type:'msg',id:s.id,ts,role:'system',kind:'usage',text,engine:entry.engine,usageKey:key}); return{appended:true,sessionId:s.id}; }

app.post('/step-up/totp',handleStepUpTotp); app.get('/passkey/status',handlePasskeyStatus); app.post('/enroll/passkey/start',handleEnrollPasskeyStart); app.post('/enroll/passkey/finish',handleEnrollPasskeyFinish); app.post('/step-up/passkey/start',handleStepUpPasskeyStart); app.post('/step-up/passkey/finish',handleStepUpPasskeyFinish); app.get('/startup/status',handleStartupStatus); app.post('/startup/unlock',handleStartupUnlock); app.post('/local-token/mint',handleLocalTokenMint);
app.post('/local-token/request',async(req,res)=>{ if(!isLocalLoopbackRequest(req))return res.status(403).json({error:'local only'}); const reason=req.body&&req.body.reason?String(req.body.reason).slice(0,160):'local orchestration'; const status=getLocalTokenStatus(); if(status.active)return res.json({ok:true,active:true,path:status.path,bootId:status.bootId}); setPendingLocalTokenRequest(reason); return res.status(202).json({ok:true,pending:true,path:status.path,bootId:status.bootId}); });

function startupGateBypass(req){ const p=req.path||'/'; if(req.method==='GET'||req.method==='HEAD'){ if(p==='/'||p==='/index.html')return true; if(path.extname(p))return true; } return false; }
function activeSupervisorSessionCount(){let count=0;for(const s of sessions.values())if(s.status==='running'||s.status==='starting')count++;return count;}
app.get('/supervisor/active-sessions',(req,res)=>{if(!isLocalLoopbackRequest(req))return res.status(403).json({error:'local only'});res.json({ok:true,activeCount:activeSupervisorSessionCount()});});
app.use((req,res,next)=>startupGateBypass(req)?next():requireStartupVerified(req,res,next));

app.get('/dirs',(req,res)=>res.json(DIRS.map(d=>{const resolved=path.resolve(d.path);return{alias:d.alias,label:d.label||d.alias,path:resolved,linkedWorktree:isLinkedGitWorktree(resolved),codexWriteAllowed:true};})));
app.get('/sessions',(req,res)=>{const metrics=createSessionRefreshMetrics({kind:'delivery',reason:'http-get-sessions'});sendMeasuredJson(res,sessionsArr(metrics),metrics);logSessionRefreshMetrics(metrics);});
app.post('/sessions/refresh',async(req,res)=>{const force=!!(req.body&&req.body.force===true);const p=nativeRefreshCoordinator.schedule(force?'manual-refresh':'api',{force});observeRefreshCompletion(p);const raced=await refreshWithResponseTimeout(p,SESSION_REFRESH_TIMEOUT_MS);if(raced===REFRESH_TIMEOUT_SENTINEL)return res.status(202).json({ok:true,timedOut:true,pending:true});if(!raced.ok)return res.status(500).json({error:raced.error||'native refresh failed'});sendMeasuredJson(res,raced,raced.metrics);});
app.get('/session/:id',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const tail=parseInt(req.query.tail||'0',10);res.json({...sessionsArr().find(m=>m.id===s.id),messages:loadMessages(s.id,tail>0?tail:0)});});
app.get('/session/:id/harness',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const dir=findHarnessDir(s.cwd);if(!dir)return res.json({ok:true,enabled:false});const state=readHarnessReviewState(dir);const provenance=verifyHarnessReviewProvenance(dir);res.json({ok:true,enabled:true,dir,unreviewed:Number(state?.unreviewed_events)||0,unreviewedNeedsReview:Number(state?.unreviewed_needs_review)||0,needsReview:Number(state?.needs_review_events)||0,lastEventId:Number(state?.last_event_id)||0,lastReviewedEventId:Number(state?.last_reviewed_event_id)||0,lastReviewedAt:state?.last_reviewed_at||null,provenanceOk:!!provenance?.ok,provenanceReason:provenance?.reason||null});});
app.get('/session/:id/file',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});try{const target=resolveSessionDownload(s.cwd,req.query.path);return res.download(target,path.basename(target));}catch(error){if(error instanceof FileDownloadError)return res.status(error.status).json({error:error.message});return res.status(500).json({error:'download failed'});}});
app.get('/all-messages',(req,res)=>{const all=[];for(const s of sessions.values())for(const m of loadMessages(s.id,0))all.push({...m,sessionId:s.id,name:s.name});all.sort((a,b)=>(a.ts||0)-(b.ts||0));res.json(all.slice(-500));});
app.get('/usage',(req,res)=>{try{res.json(getUsage({force:req.query.force==='1'}));}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});
let _authStatusCache={at:0,value:null};
app.get('/auth/engine-status',async(req,res)=>{const force=req.query.force==='1';if(!force&&_authStatusCache.value&&Date.now()-_authStatusCache.at<30_000)return res.json({ok:true,cached:true,..._authStatusCache.value});try{const status=await verifyClaudeAuth();_authStatusCache={at:Date.now(),value:status};res.json({ok:true,cached:false,...status});}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});
app.get('/auth/relogin/status',(req,res)=>res.json({ok:true,...reloginStatus()}));
app.post('/auth/relogin/start',async(req,res)=>{if(!verifyActionToken(req,res,{action:'relogin'}))return;try{const result=await startRelogin();audit(req,!!result.ok,'relogin-start',result.ok?'new':'failed');if(!result.ok)return res.status(502).json(result);res.json({ok:true,url:result.url,continuation:result.continuation,expiresAt:result.expiresAt});}catch(e){audit(req,false,'relogin-start','exception');res.status(500).json({ok:false,error:String(e&&e.message||e)});}});
app.post('/auth/relogin/code',async(req,res)=>{try{const result=await submitReloginCode(req.body&&req.body.continuation,req.body&&req.body.code);audit(req,!!result.ok,'relogin-finish',result.ok?'logged-in':'rejected');if(result.ok)_authStatusCache={at:0,value:null};res.status(result.ok?200:400).json(result);}catch(e){audit(req,false,'relogin-finish','exception');res.status(500).json({ok:false,error:String(e&&e.message||e)});}});
app.post('/auth/relogin/cancel',(req,res)=>{if(!verifyActionToken(req,res,{action:'relogin'}))return;const cancelled=cancelRelogin();audit(req,true,'relogin-cancel',cancelled?'cancelled':'nothing-pending');res.json({ok:true,cancelled});});
app.post('/server/restart',(req,res)=>{if(!verifyActionToken(req,res,{action:'restart'}))return;audit(req,true,'restart');res.json({ok:true,restarting:true});const timer=setTimeout(()=>{server.close(()=>process.exit(0));const hardExit=setTimeout(()=>process.exit(0),1500);hardExit.unref();},250);timer.unref();});
function sessionNameFromText(text){return titleSnippetFromText(text,35);} function newSessionName(text,attachments){return sessionNameFromText(text)||sessionNameFromText(attachments.map(f=>f.name).join(', '))||'new session';}
function handleSessionCreate(req,res,options={}){const{text,cwd:alias,agentType,model,effort,autoAllow}=req.body||{};const attachments=attachedFilesFrom(req.body);const promptText=text&&String(text).trim()?String(text):'';if(!promptText&&!attachments.length)return res.status(400).json({error:'text or files required'});const cwd=resolveCwd(alias);if(!cwd)return res.status(400).json({error:`未知專案 alias: ${alias}`});const at=agentType==='codex'?'codex':'claude';const normalizedEffort=normalizedEffortArg(at,effort);if(autoAllow&&!allowAutoModeAction(req,res,'create-with-autoallow'))return;const s=createSession({name:newSessionName(promptText,attachments),agentType:at,cwd,model:normalizedModelArg(at,model),effort:normalizedEffort,autoAllow:!!autoAllow});const displayText=attachmentDisplayText(promptText,attachments);const publicAttachments=attachments.map(publicAttachment);const ts=appendMsg(s,{role:'user',text:displayText,attachments:publicAttachments});broadcast({type:'msg',id:s.id,ts,text:displayText,attachments:publicAttachments,fromUser:true});broadcast({type:'sessions',data:sessionsArr()});if(!DISABLE_ENGINE_RUN)runEngine(s,promptText+attachmentPromptSection(attachments),{broadcast,isResumeTap:false}).catch(()=>{});if(typeof options.onCreated==='function')options.onCreated({session:s,cwd,agentType:at});res.json({sessionId:s.id});}
app.post('/sessions',handleSessionCreate);
function handleUpload(req,res){const{base64,filename,type,size}=req.body||{};if(!base64||typeof base64!=='string')return res.status(400).json({error:'base64 required'});const originalName=sanitizeUploadName(filename);const ext=path.extname(originalName)||'.bin';const stem=path.basename(originalName,ext).slice(0,48)||'attachment';const name=`ahr_${Date.now()}_${Math.random().toString(36).slice(2,7)}_${stem}${ext}`;const dest=path.join(AHR_MEDIA_DIR,name);try{const data=base64.includes(',')?base64.slice(base64.indexOf(',')+1):base64;const buf=Buffer.from(data,'base64');fs.mkdirSync(AHR_MEDIA_DIR,{recursive:true});fs.writeFileSync(dest,buf);cleanupExpiredUploads();res.json({id:path.basename(dest),path:dest,name:originalName,type:typeof type==='string'?type.slice(0,120):'',size:Number.isFinite(size)?size:buf.length});}catch(e){res.status(500).json({error:String(e.message)});}}
app.post('/uploads',handleUpload);app.post('/session/:id/upload',(req,res)=>{if(!sessions.has(req.params.id))return res.status(404).json({error:'not found'});handleUpload(req,res);});
app.post('/session/:id/live-input',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const{text}=req.body||{};if(!text||!String(text).trim())return res.status(400).json({error:'text required'});if(!s.proc)return res.status(409).json({error:'session is not running'});if(!canAcceptLiveInput(s))return res.status(409).json({error:'running session does not support live input for this engine'});const liveText=String(text);if(!writeLiveInput(s,liveText))return res.status(409).json({error:'live input channel is closed'});const ts=appendMsg(s,{role:'user',kind:'live-input',text:liveText});applyRetention();broadcast({type:'msg',id:s.id,ts,text:liveText,fromUser:true,kind:'live-input'});broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true,live:true});});
app.post('/session/:id/compact',async(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});if(s.proc)return res.status(409).json({error:'session is running'});const messages=loadMessages(s.id,0);const convo=conversationMessages(messages);if(convo.length<2)return res.status(400).json({error:'not enough conversation to compact'});const transcript=buildCompactTranscript(messages,COMPACT_INPUT_LIMIT);const ctx=await contextForTranscript(transcript,s,{inlineLimit:0,label:'compact',fallbackContext:buildCompactTranscript(messages,12_000)});if(!ctx.context)return res.status(500).json({error:'compact context failed'});const resetMeta=contextResetMeta(s,{op:'compact'});appendContextControl(s,{op:'compact',context:ctx.context,contextMode:ctx.mode,contextReset:resetMeta,text:'Session compacted.'});applyContextReset(s,{text:ctx.context,mode:ctx.mode,op:'compact',resetOnly:false},resetMeta);broadcast({type:'sessions',data:sessionsArr()});broadcast({type:'thread_reload',id:s.id});res.json(actionPayload(s));});
app.get('/session/:id/rewind',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const messages=loadMessages(s.id,0);const idx=userTurnIndices(messages);res.json({ok:true,turns:idx.map((i,n)=>({n:n+1,text:String(messages[i].text||'').replace(/\s+/g,' ').slice(0,240)}))});});
app.post('/session/:id/rewind',async(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});if(s.proc)return res.status(409).json({error:'session is running'});const turn=Number(req.body&&req.body.turn);const messages=loadMessages(s.id,0);const idx=userTurnIndices(messages);if(!idx.length)return res.status(400).json({error:'no user turns to rewind'});if(!Number.isInteger(turn)||turn<1||turn>idx.length)return res.status(400).json({error:`turn must be between 1 and ${idx.length}`});const kept=messages.slice(0,idx[turn-1]);const ctx=await contextForMessages(kept,s);const resetMeta=contextResetMeta(s,{op:'rewind',turn});appendContextControl(s,{op:'rewind',turn,context:ctx.context,contextMode:ctx.mode,contextReset:resetMeta,text:'Session rewound.'});applyContextReset(s,{text:ctx.context,mode:ctx.mode,op:'rewind',resetOnly:!ctx.context},resetMeta);broadcast({type:'sessions',data:sessionsArr()});broadcast({type:'thread_reload',id:s.id});res.json(actionPayload(s));});
function startSessionTurn(s,input,{echoToClients=false}={}){const{text,agentType,model,effort}=input||{};const hasText=text&&String(text).trim();const attachments=attachedFilesFrom(input);if(!hasText&&!attachments.length)return{status:400,body:{error:'text or files required'}};const nextAgentType=agentType==='codex'?'codex':(agentType==='claude'?'claude':s.agentType);if(agentType==='claude'||agentType==='codex')s.agentType=agentType;if(typeof model==='string')s.model=model||null;if(typeof effort==='string')s.effort=normalizedEffortArg(nextAgentType,effort);s.model=normalizedModelArg(nextAgentType,s.model);s.archived=false;const pendingContext=pendingContextFromControls(s);if(pendingContext)s.pendingContext=pendingContext;const hasHistory=loadMessages(s.id,0).some(m=>m.role==='user'||m.role==='assistant');const plan=continuationPlan(s,{engine:nextAgentType,hasHistory,confirmBridge:!!input?.confirmBridge,pendingContext:!!s.pendingContext});if(plan.gate)return{status:409,body:{error:'resume failed; bridge consent required',needBridgeConsent:true}};const safeText=hasText?String(text):'';const displayText=attachmentDisplayText(safeText,attachments);const publicAttachments=attachments.map(publicAttachment);const ts=appendMsg(s,{role:'user',text:displayText,attachments:publicAttachments});applyRetention();broadcast(echoToClients?{type:'msg',id:s.id,ts,role:'user',text:displayText,attachments:publicAttachments}:{type:'msg',id:s.id,ts,text:displayText,attachments:publicAttachments,fromUser:true});broadcast({type:'sessions',data:sessionsArr()});runEngine(s,safeText+attachmentPromptSection(attachments),{broadcast,isResumeTap:true,forceBridge:plan.forceBridge}).catch(()=>{});return null;}
function handleSessionSend(req,res){const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});if(s.proc)return res.status(409).json({error:'session busy'});const blocked=startSessionTurn(s,req.body||{});if(blocked)return res.status(blocked.status).json(blocked.body);res.json({ok:true});}
app.post('/session/:id/send',handleSessionSend);
function sessionBusy(s){return!!(s.proc||s.status==='running'||s.status==='starting');}
function drainQueuedInput(s){if(sessionBusy(s))return;const item=dequeueInput(s);if(!item)return;const blocked=startSessionTurn(s,{text:item.text,files:item.files},{echoToClients:true});if(blocked)requeueInput(s,item);broadcast({type:'sessions',data:sessionsArr()});}
setTurnEndHook((s,info)=>{const pending=queuedInputs(s);if(!pending.length)return;const code=info?info.code:-1;const cancelled=!!info?.cancelled;if(cancelled||code!==0)return;setTimeout(()=>drainQueuedInput(s),0);});
app.post('/session/:id/queue',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const{text,files}=req.body||{};const attachments=(Array.isArray(files)?files:[]).map(normalizeAttachedFile).filter(Boolean);if((!text||!String(text).trim())&&!attachments.length)return res.status(400).json({error:'text or files required'});if(!sessionBusy(s)&&!queuedInputs(s).length){const blocked=startSessionTurn(s,{text,files:attachments},{echoToClients:true});if(blocked)return res.status(blocked.status).json(blocked.body);return res.json({ok:true,queued:false,queue:[]});}const item=enqueueInput(s,text,attachments);if(!item)return res.status(409).json({error:`queue full (${QUEUE_LIMIT})`});broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true,queued:true,queue:queuedInputs(s)});});
app.post('/session/:id/queue/remove',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const qid=req.body&&req.body.qid;if(!qid)return res.status(400).json({error:'qid required'});if(!removeQueuedInput(s,qid))return res.status(404).json({error:'queued item not found'});broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true,queue:queuedInputs(s)});});
app.post('/session/:id/queue/clear',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const removed=clearQueuedInputs(s);if(removed)broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true,removed,queue:[]});});
app.post('/session/:id/cancel',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});if(s.proc){s.cancelled=true;killTree(s.proc);}res.json({ok:true});});
app.post('/session/:id/rename',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const name=req.body&&req.body.name;if(!name||!String(name).trim())return res.status(400).json({error:'name required'});s.name=String(name).trim().slice(0,80);s.updatedAt=Date.now();persistIndex();broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true});});
app.post('/session/:id/model',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const{model,agentType}=req.body||{};if(agentType==='claude'||agentType==='codex'){if(agentType!==s.agentType)s.model=null;s.agentType=agentType;}if(typeof model==='string')s.model=model||null;s.model=normalizedModelArg(s.agentType,s.model);s.updatedAt=Date.now();persistIndex();broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true,agentType:s.agentType,model:s.model});});
app.post('/session/:id/autoallow',(req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:'not found'});const on=!!req.body?.on;if(on&&!allowAutoModeAction(req,res,'autoallow-on',s.id))return;s.autoAllow=on;audit(req,true,on?'autoallow-on':'autoallow-off',s.id);persistIndex();broadcast({type:'sessions',data:sessionsArr()});res.json({ok:true,autoAllow:s.autoAllow});});

const PUBLIC_DIR=path.join(__dirname,'public');
app.use(express.static(PUBLIC_DIR,{setHeaders(res,filePath){if(/\.(?:html|css|js|jsx)$/.test(filePath))res.setHeader('Cache-Control','no-cache');}}));
app.get('/',(req,res)=>{const idx=path.join(PUBLIC_DIR,'index.html');if(fs.existsSync(idx))return res.sendFile(idx);res.type('html').send('<!DOCTYPE html><meta charset="UTF-8"><body><h1>agent-hub-remote</h1></body>');});
server.listen(PORT,BIND_HOST,()=>{recoverInterruptedSessions();nativeRefreshCoordinator.schedule('startup',{force:false}).then(r=>logSessionRefreshMetrics(r.metrics)).catch(()=>{});cleanupExpiredUploads();armPersistedAutoResumes(broadcast);startUsageApiPoller();deliverDueReminders();setInterval(()=>deliverDueReminders(),60000).unref();});
function reapChildren(){for(const s of sessions.values())if(s.proc)killTree(s.proc);} let shuttingDown=false; async function gracefulShutdown(){if(shuttingDown)return;shuttingDown=true;reapChildren();try{await nativeRefreshCoordinator.shutdown();}catch{}process.exit(0);} process.on('SIGINT',()=>{gracefulShutdown();});process.on('SIGTERM',()=>{gracefulShutdown();});
