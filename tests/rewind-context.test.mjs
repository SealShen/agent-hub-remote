import assert from 'node:assert/strict';

import {
  REWIND_FALLBACK_LIMIT,
  clipRewindTranscript,
  rewindTranscriptFallback,
} from '../rewind-context.js';

const shortTranscript = 'User: first\n\nAssistant: second';
assert.equal(clipRewindTranscript(shortTranscript), shortTranscript);

const longTranscript = 'A'.repeat(8000) + '\nMIDDLE\n' + 'Z'.repeat(8000);
const clipped = clipRewindTranscript(longTranscript);

assert.ok(clipped.length <= REWIND_FALLBACK_LIMIT);
assert.match(clipped, /rewind context truncated/);
assert.ok(clipped.startsWith('AAAA'));
assert.ok(clipped.endsWith('ZZZZ'));

const fallback = rewindTranscriptFallback(longTranscript);
assert.equal(fallback.mode, 'transcript');
assert.equal(fallback.context, clipped);

console.log('rewind context fallback ok');
