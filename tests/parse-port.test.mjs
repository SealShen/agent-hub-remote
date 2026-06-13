import assert from 'node:assert/strict';
import { parsePort } from '../env.js';

// parsePort must never yield NaN: invalid/out-of-range/missing inputs fall back.
assert.equal(parsePort('3334'), 3334, 'valid port string');
assert.equal(parsePort('80'), 80, 'low valid port');
assert.equal(parsePort('65535'), 65535, 'max valid port');
assert.equal(parsePort(undefined), 3334, 'missing -> default');
assert.equal(parsePort(''), 3334, 'empty -> default');
assert.equal(parsePort('abc'), 3334, 'non-numeric -> default');
assert.equal(parsePort('0'), 3334, 'zero out of range -> default');
assert.equal(parsePort('-5'), 3334, 'negative -> default');
assert.equal(parsePort('70000'), 3334, 'above 65535 -> default');
assert.equal(parsePort('3000', 9999), 3000, 'custom fallback unused when valid');
assert.equal(parsePort('nope', 9999), 9999, 'custom fallback used when invalid');
// parseInt tolerates trailing junk; ensure that stays a valid in-range int, not NaN.
assert.equal(parsePort('8080abc'), 8080, 'parseInt trailing junk still in range');

console.log('parse-port fallback ok');
