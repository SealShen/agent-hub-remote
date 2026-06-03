import { isSensitivePath } from './tool-display.js';

const MAX_CONTEXT_MESSAGE_CHARS = 5000;
const COMMAND_SUCCESS_TAIL_CHARS = 600;
const COMMAND_FAILURE_TAIL_CHARS = 1600;

const TOOL_USE_PREFIX = '\u23f5';
const TOOL_RESULT_PREFIX = '\u23f4';

function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `...[truncated ${s.length - max} chars]`;
}

function extractPath(input) {
  if (!input || typeof input !== 'object') return '';
  return input.file_path || input.path || input.notebook_path || '';
}

function parseToolUse(line) {
  const body = String(line || '').replace(TOOL_USE_PREFIX, '').trim();
  const match = body.match(/^([^\s{]+)(?:\s+([\s\S]+))?$/);
  if (!match) return { name: 'tool', input: null };
  const name = match[1] || 'tool';
  const rawInput = match[2] || '';
  if (!rawInput) return { name, input: null };
  try {
    return { name, input: JSON.parse(rawInput) };
  } catch {
    return { name, input: null, rawInput };
  }
}

function projectedToolUse(line) {
  const { name, input, rawInput } = parseToolUse(line);
  const filePath = extractPath(input);
  if (filePath) {
    if (isSensitivePath(filePath)) return `${TOOL_USE_PREFIX} ${name}: sensitive path hidden`;
    return `${TOOL_USE_PREFIX} ${name}: ${filePath}`;
  }
  if (input && name === 'Bash') {
    const label = input.description || input.command || 'command';
    return `${TOOL_USE_PREFIX} Bash: ${clip(label, 180)}`;
  }
  if (input && input.command) return `${TOOL_USE_PREFIX} ${name}: ${clip(input.command, 180)}`;
  if (rawInput && /(?:^|[\\/])(?:\.env(?:[.\w-]*)?|.*\.(?:pem|key|p12|pfx))/i.test(rawInput)) {
    return `${TOOL_USE_PREFIX} ${name}: sensitive input hidden`;
  }
  return `${TOOL_USE_PREFIX} ${name}: input omitted`;
}

function projectNativeToolMarkers(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let inToolResult = false;
  let sawNonToolText = false;
  let sawToolUse = false;
  let sawToolResult = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(TOOL_USE_PREFIX)) {
      sawToolUse = true;
      inToolResult = false;
      out.push(projectedToolUse(trimmed));
      continue;
    }
    if (trimmed.startsWith(TOOL_RESULT_PREFIX)) {
      sawToolResult = true;
      inToolResult = true;
      continue;
    }
    if (inToolResult) continue;
    if (line.trim()) sawNonToolText = true;
    out.push(line);
  }

  const projected = out.join('\n').trim();
  if (!projected && sawToolResult && !sawNonToolText && !sawToolUse) return '';
  return projected;
}

function projectCommandExecutionText(text) {
  const value = String(text || '').trim();
  const match = value.match(/^```bash\n([\s\S]*?)\n```\s*([\s\S]*)$/);
  if (!match) return text;

  const command = match[1].trim();
  const rest = match[2].trim();
  if (!rest) return text;

  const exitMatch = rest.match(/\(exit\s+(\d+)\)\s*$/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : 0;
  const output = rest.replace(/\(exit\s+\d+\)\s*$/, '').trim();
  const failed = Number.isFinite(exitCode) && exitCode !== 0;
  const max = failed ? COMMAND_FAILURE_TAIL_CHARS : COMMAND_SUCCESS_TAIL_CHARS;
  const tail = output.length > max ? output.slice(-max) : output;

  const parts = [`Command: ${clip(command.replace(/\s+/g, ' '), 240)}`];
  if (failed) parts.push(`Exit: ${exitCode}`);
  if (tail) {
    const omitted = output.length > max ? output.length - max : 0;
    parts.push(`${failed ? 'Output tail' : 'Output'}:\n${tail}${omitted ? `\n... [omitted ${omitted} chars]` : ''}`);
  }
  return parts.join('\n');
}

function projectDiffDisplay(text) {
  const value = String(text || '').trim();
  const firstLine = value.split(/\r?\n/, 1)[0] || '';
  if (!/(^Tool diff$|^(Edit|MultiEdit|Write):\s+)/.test(firstLine)) return text;
  if (/Diff hidden for sensitive-looking path\./.test(value)) return `${firstLine}\nDiff hidden for sensitive-looking path.`;
  return `${firstLine}\nDiff omitted from inherited context.`;
}

export function projectContextText(text) {
  let out = String(text || '');
  out = projectNativeToolMarkers(out);
  if (!out) return '';
  out = projectCommandExecutionText(out);
  out = projectDiffDisplay(out);
  return clip(out.trim(), MAX_CONTEXT_MESSAGE_CHARS);
}

export function projectContextMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'system') {
      if ((m.kind === 'compact' || m.kind === 'rewind') && m.context) out.push(m);
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = projectContextText(m.text);
    if (!text) continue;
    out.push({ ...m, text });
  }
  return out;
}
