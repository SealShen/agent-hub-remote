export const REWIND_FALLBACK_LIMIT = 12_000;

export function clipRewindTranscript(transcript, maxChars = REWIND_FALLBACK_LIMIT) {
  const text = String(transcript || '').trim();
  if (text.length <= maxChars) return text;
  const marker = `\n\n...[rewind context truncated ${text.length - maxChars} chars]...\n\n`;
  const headChars = Math.floor((maxChars - marker.length) * 0.45);
  const tailChars = Math.max(0, maxChars - marker.length - headChars);
  return text.slice(0, headChars).trimEnd() + marker + text.slice(-tailChars).trimStart();
}

export function rewindTranscriptFallback(transcript) {
  return {
    context: clipRewindTranscript(transcript),
    mode: 'transcript',
  };
}
