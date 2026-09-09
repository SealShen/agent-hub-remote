const BRIDGE_CONTEXT_PREFIX = '[\u4ee5\u4e0b\u662f\u9019\u689d\u5c0d\u8a71\u5148\u524d\u5728 ';
const BRIDGE_NEW_MESSAGE_MARKER = '[\u4f7f\u7528\u8005\u7684\u65b0\u8a0a\u606f]';
const RESET_CONTEXT_PREFIX = '[The previous conversation has been reset.';
const RESET_NEW_MESSAGE_MARKER = "[User's new message]";
const TRANSCRIPT_USER_MARKER = 'User:';
function normalizeTitleText(text){return String(text||'').replace(/\s+/g,' ').trim();}
function textAfterFirstMarker(raw,markers){for(const marker of markers){const i=raw.indexOf(marker);if(i!==-1)return normalizeTitleText(raw.slice(i+marker.length));}return '';}
export function stripBridgePreambleForTitle(text){const raw=String(text||'').trim();const normalized=normalizeTitleText(raw);if(!normalized)return '';if(normalized.startsWith(BRIDGE_CONTEXT_PREFIX))return textAfterFirstMarker(raw,[BRIDGE_NEW_MESSAGE_MARKER,TRANSCRIPT_USER_MARKER]);if(normalized.startsWith(RESET_CONTEXT_PREFIX))return textAfterFirstMarker(raw,[RESET_NEW_MESSAGE_MARKER]);return normalized;}
export function titleSnippetFromText(text,maxLen=60){return stripBridgePreambleForTitle(text).slice(0,maxLen);}
