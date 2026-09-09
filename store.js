// 持久化層（plan §二-B、#3 #8 #10 #6）
//  - .state/index.json    : 僅 metadata 陣列，write-file-atomic（Windows-safe）
//  - .state/sessions/<id>.jsonl : 訊息 append-only，每行一則（避免整檔重寫）
//  - 開機 hydrate：重建 Map；running/starting → interrupted + 系統訊息
//  - 每專案(cwd)各保留最近 50（updatedAt），超過者 archived（主列表隱藏、仍可接回）
//  - 身分 = hub 內部穩定 id（uuid）；engineRefs{claude,codex} 為 per-engine 指標

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import writeFileAtomic from 'write-file-atomic';
import { scanNative, scanCodexNative, loadNative, loadCodexNative, createNativeIoLimiter } from './ingest.js';
import {
  incrementRefreshCounter,
  measureRefreshPhase,
  recordRefreshError,
} from './session-refresh-instrumentation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.AHR_STATE_DIR
  ? path.resolve(process.env.AHR_STATE_DIR)
  : path.join(__dirname, '.state');
const SESS_DIR = path.join(STATE_DIR, 'sessions');
const INDEX_PATH = path.join(STATE_DIR, 'index.json');
export { STATE_DIR };
const CONTEXT_CONTROL_KIND = 'context-control';

const RETAIN = 50;
const MSG_CACHE_CAP = 2000;
fs.mkdirSync(SESS_DIR, { recursive: true });
export function newId() { return crypto.randomUUID(); }
export const sessions = new Map();
const pendingNativeQueueMeta = new Map();
function jsonlPath(id) { return path.join(SESS_DIR, id + '.jsonl'); }
function metaOf(s) {
  return {
    id:s.id,name:s.name,status:s.status,agentType:s.agentType,cwd:s.cwd,model:s.model||null,effort:s.effort||null,autoAllow:!!s.autoAllow,archived:!!s.archived,
    engineRefs:{claude:s.engineRefs?.claude??null,codex:s.engineRefs?.codex??null},lastEngine:s.lastEngine||null,
    codexBootstrapEvidence:s.codexBootstrapEvidence||null,autoResume:s.autoResume||null,queued:queuedInputs(s),pid:s.pid??null,msgCount:s.msgCount||0,
    source:s.source||null,nativePath:s.nativePath||null,contextReset:s.contextReset||null,createdAt:s.createdAt,updatedAt:s.updatedAt,
  };
}
export const QUEUE_LIMIT=20;
export function queuedInputs(s){return Array.isArray(s?.queued)?s.queued:[];}
export function allQueuedInputs(){const items=[];for(const session of sessions.values())items.push(...queuedInputs(session));for(const [id,meta] of pendingNativeQueueMeta){if(!sessions.has(id))items.push(...queuedInputs(meta));}return items;}
export function enqueueInput(s,text,files){const body=String(text??'');const attachments=Array.isArray(files)?files.filter(Boolean):[];if(!body.trim()&&!attachments.length)return null;const list=queuedInputs(s);if(list.length>=QUEUE_LIMIT)return null;const item={id:newId(),text:body,ts:Date.now()};if(attachments.length)item.files=attachments;s.queued=[...list,item];persistIndex();return item;}
export function dequeueInput(s){const list=queuedInputs(s);if(!list.length)return null;s.queued=list.slice(1);persistIndex();return list[0];}
export function requeueInput(s,item){if(!item)return;s.queued=[item,...queuedInputs(s)];persistIndex();}
export function removeQueuedInput(s,qid){const list=queuedInputs(s);const next=list.filter(q=>q&&q.id!==qid);if(next.length===list.length)return false;s.queued=next;persistIndex();return true;}
export function clearQueuedInputs(s){const n=queuedInputs(s).length;if(!n)return 0;s.queued=[];persistIndex();return n;}
let persistTimer=null;
export function persistIndex(){if(persistTimer)return;persistTimer=setTimeout(()=>{persistTimer=null;const arr=[...sessions.values()].map(metaOf);for(const [id,meta] of pendingNativeQueueMeta){if(!sessions.has(id))arr.push(meta);}try{writeFileAtomic.sync(INDEX_PATH,JSON.stringify(arr));}catch(e){console.error('[store] index 寫入失敗:',e.message);}},250);}
export function appendMsg(s,entry){if(entry.ts==null)entry.ts=Date.now();try{fs.appendFileSync(jsonlPath(s.id),JSON.stringify(entry)+'\n');}catch(e){console.error('[store] jsonl append 失敗:',e.message);}s.messages.push(entry);if(s.messages.length>MSG_CACHE_CAP)s.messages.shift();s.msgCount=(s.msgCount||0)+1;s.updatedAt=entry.ts;persistIndex();return entry.ts;}
export function removeSession(id,{deleteLog=false}={}){const existed=sessions.delete(id);if(deleteLog){try{fs.rmSync(jsonlPath(id),{force:true});}catch(e){console.error('[store] session jsonl delete failed:',e.message);}}if(existed){applyRetention();persistIndex();}return existed;}
export function hubMessageCount(id){return readHubJsonl(id).length;}
export function absorbHubMessages(fromId,owner){if(!owner||fromId===owner.id)return 0;const entries=readHubJsonl(fromId);if(!entries.length)return 0;let maxTs=owner.updatedAt||0;for(const entry of entries){appendMsg(owner,entry);if(typeof entry.ts==='number'&&entry.ts>maxTs)maxTs=entry.ts;}owner.updatedAt=maxTs;persistIndex();return entries.length;}
function readHubJsonl(id){let lines;try{lines=fs.readFileSync(jsonlPath(id),'utf8').split('\n').filter(Boolean);}catch{return [];}const out=[];for(const l of lines){try{out.push(JSON.parse(l));}catch{}}return out;}
function isContextControl(m){return m&&m.role==='system'&&m.kind===CONTEXT_CONTROL_KIND;}
function latestContextReset(id){let reset=null;for(const m of readHubJsonl(id)){if(isContextControl(m)&&m.contextReset)reset=m.contextReset;}return reset;}
function publicControlMessage(m){const out={role:'system',kind:m.op==='rewind'?'rewind':'compact',text:m.text||(m.op==='rewind'?'Session rewound.':'Session compacted.'),ts:m.ts||Date.now()};if(m.context)out.context=m.context;if(m.contextMode)out.contextMode=m.contextMode;if(m.contextReset)out.contextReset=m.contextReset;if(m.op)out.op=m.op;if(m.turn!=null)out.turn=m.turn;return out;}
function userTurnIndices(messages){const idx=[];messages.forEach((m,i)=>{if(m&&m.role==='user'&&m.text&&String(m.text).trim())idx.push(i);});return idx;}
function projectMessages(raw){let out=[];for(const m of raw){if(isContextControl(m)){const display=publicControlMessage(m);if(m.op==='compact'){out=[display];}else if(m.op==='rewind'){const turn=Number(m.turn);const idx=userTurnIndices(out);const cut=Number.isInteger(turn)&&turn>=1&&turn<=idx.length?idx[turn-1]:out.length;out=out.slice(0,cut);out.push(display);}else out.push(display);continue;}out.push(m);}return out;}
function combinedMessages(id){const rec=sessions.get(id);if(rec&&rec.source==='native'){const nativeEngineType=rec.nativeEngineType||rec.agentType;const hist=nativeEngineType==='codex'?loadCodexNative(rec.nativePath,0):loadNative(rec.nativePath,0);return hist.concat(readHubJsonl(id));}return readHubJsonl(id);}
export function loadMessages(id,tail){const out=projectMessages(combinedMessages(id));if(tail&&tail>0&&out.length>tail)return out.slice(-tail);return out;}
export function appendContextControl(s,{op,turn,context,contextMode,text,contextReset}){const ts=appendMsg(s,{role:'system',kind:CONTEXT_CONTROL_KIND,op,turn,context:context||'',contextMode:contextMode||null,contextReset:contextReset||null,text});if(contextReset)s.contextReset=contextReset;return ts;}
export function syncMessageCount(s){if(!s)return 0;const count=loadMessages(s.id,0).length;s.msgCount=count;s.updatedAt=Date.now();persistIndex();return count;}
export function pendingContextFromControls(s){if(!s)return null;const raw=combinedMessages(s.id);let pending=null;for(const m of raw){if(isContextControl(m)){pending={text:m.context||'',mode:m.contextMode||m.op||'reset',op:m.op||'reset',resetOnly:!m.context,freshThread:true,contextReset:m.contextReset||null,ts:m.ts||null};}else if(pending&&m.role==='user'&&m.text&&String(m.text).trim()){pending=null;}}return pending;}
function blankRecord(meta){return {...meta,engineRefs:meta.engineRefs||{claude:null,codex:null},messages:[],proc:null,cancelled:false};}
export function hydrate(){let arr=[];pendingNativeQueueMeta.clear();try{arr=JSON.parse(fs.readFileSync(INDEX_PATH,'utf8'));if(!Array.isArray(arr))arr=[];}catch{arr=[];}const orphans=[];for(const meta of arr){if(!meta||!meta.id)continue;if(meta.source==='native'){if(queuedInputs(meta).length)pendingNativeQueueMeta.set(meta.id,meta);continue;}const wasActive=meta.status==='running'||meta.status==='starting';if(wasActive&&meta.pid)orphans.push({id:meta.id,pid:meta.pid});const rec=blankRecord(meta);rec.contextReset=meta.contextReset||latestContextReset(meta.id)||null;rec.pid=null;if(wasActive){rec.status='interrupted';const note={role:'system',text:'↻ 服務已重啟，此對話被中斷 — 點此可續接',ts:Date.now()};try{fs.appendFileSync(jsonlPath(rec.id),JSON.stringify(note)+'\n');}catch{}rec.msgCount=(rec.msgCount||0)+1;rec.updatedAt=note.ts;}rec.messages=loadMessages(rec.id,MSG_CACHE_CAP);if(!rec.messages.length&&(rec.msgCount||0)===0)continue;sessions.set(rec.id,rec);}applyRetention();persistIndex();return orphans;}
export function applyRetention(){const byCwd=new Map();for(const s of sessions.values()){const key=s.cwd||'';if(!byCwd.has(key))byCwd.set(key,[]);byCwd.get(key).push(s);}for(const group of byCwd.values()){group.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));group.forEach((s,i)=>{s.archived=i>=RETAIN;});}}
export async function ingestProjects(cwdList,metrics=null,{forceProjectDiscovery=false}={}){const workspaces=(cwdList||[]).filter(Boolean);incrementRefreshCounter(metrics,'nativeScans');if(metrics)metrics.counters.workspaceCount=workspaces.length;let added=0;let taken;const ingestMetas=(metas)=>{measureRefreshPhase(metrics,'reconciliationMs',()=>{for(const m of metas){if(m.empty)continue;if(taken.has(m.id)){const existing=sessions.get(m.id);if(existing?.source==='native'&&/^\s*<recommended_plugins>/i.test(existing.name||'')&&m.name&&!/^\s*<recommended_plugins>/i.test(m.name)){existing.name=m.name;existing.updatedAt=Math.max(Number(existing.updatedAt)||0,Number(m.updatedAt)||0);}continue;}taken.add(m.id);const persistedNativeMeta=pendingNativeQueueMeta.get(m.id);pendingNativeQueueMeta.delete(m.id);sessions.set(m.id,{id:m.id,name:m.name,status:'idle',agentType:m.agentType==='codex'?'codex':'claude',cwd:m.cwd,model:null,effort:null,autoAllow:false,archived:false,engineRefs:m.engineRefs||{claude:m.id,codex:null},lastEngine:m.agentType==='codex'?'codex':'claude',pid:null,msgCount:0,source:'native',nativeEngineType:m.agentType==='codex'?'codex':'claude',nativePath:m.nativePath,createdAt:m.createdAt,updatedAt:m.updatedAt,messages:[],queued:persistedNativeMeta?queuedInputs(persistedNativeMeta):[],proc:null,cancelled:false});added++;}});};const limiter=createNativeIoLimiter();const codexScan=scanCodexNative(workspaces,metrics,{limiter}).catch(e=>{recordRefreshError(metrics,'codex-scan');console.error('[ingest] codex scan 失敗:',e.message);return[];});const claudeScans=Promise.all(workspaces.map(cwd=>scanNative(cwd,metrics,{forceDiscovery:forceProjectDiscovery,limiter}).catch(e=>{recordRefreshError(metrics,'claude-scan');console.error('[ingest] claude scan 失敗:',cwd,e.message);return[];})));const[codexMetas,claudeMetasByWorkspace]=await Promise.all([codexScan,claudeScans]);const codexMetasByWorkspace=new Map();for(const meta of codexMetas){const key=path.resolve(meta.cwd).toLowerCase();if(!codexMetasByWorkspace.has(key))codexMetasByWorkspace.set(key,[]);codexMetasByWorkspace.get(key).push(meta);}taken=measureRefreshPhase(metrics,'reconciliationMs',()=>{const ids=new Set();for(const s of sessions.values()){ids.add(s.id);if(s.engineRefs?.claude)ids.add(s.engineRefs.claude);if(s.engineRefs?.codex)ids.add(`codex-${s.engineRefs.codex}`);}return ids;});for(let i=0;i<workspaces.length;i++){const cwd=workspaces[i];ingestMetas(claudeMetasByWorkspace[i]);const codexKey=typeof cwd==='string'&&cwd.trim()?path.resolve(cwd).toLowerCase():null;ingestMetas(codexKey?codexMetasByWorkspace.get(codexKey)||[]:[]);if(codexKey)codexMetasByWorkspace.delete(codexKey);}measureRefreshPhase(metrics,'reconciliationMs',applyRetention);persistIndex();return added;}
export function createSession({name,agentType,cwd,model,effort,autoAllow}){const now=Date.now();const s={id:newId(),name:name||null,status:'idle',agentType,cwd,model:model||null,effort:effort||null,autoAllow:!!autoAllow,archived:false,engineRefs:{claude:null,codex:null},lastEngine:null,pid:null,msgCount:0,createdAt:now,updatedAt:now,messages:[],queued:[],proc:null,cancelled:false};sessions.set(s.id,s);applyRetention();persistIndex();return s;}
export function sessionsArr(metrics=null){return measureRefreshPhase(metrics,'sessionsMaterializationMs',()=>[...sessions.values()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).map(metaOf));}
