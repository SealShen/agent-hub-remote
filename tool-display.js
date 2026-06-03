const DIFF_DISPLAY_MAX = 12000;
const SENSITIVE_PATH_RE = /(^|[\\/])(?:\.env(?:[.\w-]*)?|.*\.(?:pem|key|p12|pfx)|.*(?:token|secret|password|credential).*)$/i;

export function truncateText(text, max = DIFF_DISPLAY_MAX) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`,
    truncated: true,
  };
}

export function isSensitivePath(filePath) {
  const value = String(filePath || '').replace(/\\/g, '/');
  if (!value) return false;
  return SENSITIVE_PATH_RE.test(value);
}

export function hasSensitivePath(paths) {
  return (paths || []).some(isSensitivePath);
}

function escapeFence(text) {
  return String(text || '').replaceAll('```', '` ` `');
}

export function formatDiffBlock(diffText) {
  if (!diffText) return '';
  return '```diff\n' + escapeFence(diffText) + '\n```';
}

export function formatShellCommandBlock(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  return '```bash\n' + escapeFence(cmd) + '\n```';
}

export function formatCodexCommandExecution(item, maxOutput = 2000) {
  if (!item || item.type !== 'command_execution') return '';
  const cmd = formatShellCommandBlock(item.command);
  const out = String(item.aggregated_output || '').trim();
  const exit = item.exit_code;
  const parts = [];
  if (cmd) parts.push(cmd);
  if (out) parts.push(out.slice(-maxOutput));
  if (exit != null && exit !== 0) parts.push(`(exit ${exit})`);
  return parts.join('\n\n');
}

function lines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function pathHeader(filePath, from = filePath) {
  return [`--- ${from}`, `+++ ${filePath}`];
}

function editDiff(filePath, oldText, newText, label = '@@') {
  const out = [...pathHeader(filePath), label];
  for (const line of lines(oldText)) out.push('-' + line);
  for (const line of lines(newText)) out.push('+' + line);
  return out.join('\n');
}

function writeDiff(filePath, content) {
  const out = [...pathHeader(filePath, '/dev/null'), '@@'];
  for (const line of lines(content)) out.push('+' + line);
  return out.join('\n');
}

function toolTitle(name, filePath) {
  return `${name}: ${filePath || '(unknown path)'}`;
}

function hiddenToolText(name, filePath) {
  return `${toolTitle(name, filePath)}\n\nDiff hidden for sensitive-looking path.`;
}

export function formatClaudeToolUse(block, max = DIFF_DISPLAY_MAX) {
  if (!block || block.type !== 'tool_use') return null;
  const name = block.name || '';
  const input = block.input || {};
  const filePath = input.file_path || input.path || input.notebook_path || '';

  if (name === 'Edit') {
    if (isSensitivePath(filePath)) return hiddenToolText(name, filePath);
    const diff = editDiff(filePath, input.old_string || '', input.new_string || '');
    const clipped = truncateText(diff, max);
    return `${toolTitle(name, filePath)}\n\n${formatDiffBlock(clipped.text)}`;
  }

  if (name === 'MultiEdit') {
    if (isSensitivePath(filePath)) return hiddenToolText(name, filePath);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!edits.length) return null;
    const hunks = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] || {};
      hunks.push(editDiff(filePath, e.old_string || '', e.new_string || '', `@@ edit ${i + 1}`));
    }
    const clipped = truncateText(hunks.join('\n'), max);
    return `${toolTitle(name, filePath)}\n\n${formatDiffBlock(clipped.text)}`;
  }

  if (name === 'Write') {
    if (isSensitivePath(filePath)) return hiddenToolText(name, filePath);
    const diff = writeDiff(filePath, input.content || '');
    const clipped = truncateText(diff, max);
    return `${toolTitle(name, filePath)}\n\n${formatDiffBlock(clipped.text)}`;
  }

  if (name === 'Bash') {
    const cmd = formatShellCommandBlock(input.command);
    if (!cmd) return null;
    const title = input.description ? `Bash: ${input.description}` : 'Bash';
    return `${title}\n\n${cmd}`;
  }

  return null;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

function looksLikeDiff(text) {
  return /(^|\n)diff --git /.test(text) ||
    ((/(^|\n)@@/.test(text)) && /(^|\n)[+-]/.test(text));
}

function diffMentionsSensitivePath(text) {
  const paths = [];
  for (const line of lines(text)) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(/\s+/).slice(2);
      for (const p of parts) paths.push(p.replace(/^[ab]\//, ''));
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const p = line.slice(4).trim().replace(/^[ab]\//, '');
      if (p && p !== '/dev/null') paths.push(p);
    }
  }
  return hasSensitivePath(paths);
}

export function formatClaudeToolResult(block, max = DIFF_DISPLAY_MAX) {
  if (!block || block.type !== 'tool_result') return null;
  const text = extractTextContent(block.content);
  if (!text || !looksLikeDiff(text)) return null;
  if (diffMentionsSensitivePath(text)) return 'Tool diff\n\nDiff hidden for sensitive-looking path.';
  const clipped = truncateText(text, max);
  return `Tool diff\n\n${formatDiffBlock(clipped.text)}`;
}
