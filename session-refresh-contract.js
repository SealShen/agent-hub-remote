// Session refresh contract established in batch 1 and wired into runtime caller
// policy, successful-result TTL, and Claude directory discovery in batch 2.

function frozen(value) {
  if (Array.isArray(value)) {
    value.forEach(frozen);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
  }
  return Object.freeze(value);
}

export const SESSION_REFRESH_API_CONTRACT = frozen({
  loadSessions: {
    method: 'GET',
    path: '/sessions',
    nativeDiscovery: false,
    source: 'published-memory-snapshot',
  },
  ingestNativeSessions: {
    method: 'POST',
    path: '/sessions/refresh',
    nativeDiscovery: true,
    manualForceBypassesCompletedResultTtl: true,
  },
  websocketSessions: {
    source: 'same-published-memory-snapshot-as-get',
  },
});

export const SESSION_REFRESH_CALLER_POLICY = frozen([
  { id: 'server-startup', policy: 'startup-ingest-once-per-boot' },
  { id: 'frontend-initial-load', policy: 'ttl-native-ingest' },
  { id: 'startup-unlock', policy: 'ttl-native-ingest' },
  { id: 'websocket-reconnect', policy: 'get-snapshot-then-thread-backfill' },
  { id: 'focus-visibility', policy: 'ttl-native-ingest' },
  { id: 'open-drawer', policy: 'websocket-state-or-conditional-get' },
  { id: 'deduped-create', policy: 'get-snapshot' },
  { id: 'manual-refresh-button', policy: 'forced-native-ingest' },
  { id: 'usage-notify', policy: 'background-ttl-native-ingest' },
]);

export const COMPLETED_RESULT_TTL_CONTRACT = frozen({
  defaultMs: 30_000,
  reusesPublishedSnapshot: true,
  successOnly: true,
  failureExtendsTtl: false,
  manualForceBypasses: true,
});

export const NATIVE_SCAN_RESULT_CONTRACT = frozen({
  requiredKeys: ['complete', 'entries', 'seenPaths', 'errors', 'rootsScanned'],
  errorRequiredKeys: ['stage', 'path'],
  forbiddenErrorKeys: ['content', 'messages', 'raw', 'text', 'title', 'transcript'],
  deletionRequiresCompleteRootScan: true,
  rootTraversalErrorKeepsPreviousSnapshot: true,
  fileErrorKeepsPreviousMetadata: true,
});

export const SESSION_FIELD_OWNERSHIP = frozen({
  nativeDerived: [
    'nativeIdentity',
    'nativeEngineType',
    'nativePath',
    'discoveredCwd',
    'nativeCandidateTitle',
    'nativeCreatedAt',
    'nativeObservedMtime',
    'filesystemFingerprint',
    'nativeAvailability',
    'nativeStale',
    'nativeScanError',
  ],
  hubOwned: [
    'name',
    'nameSource',
    'agentType',
    'status',
    'model',
    'effort',
    'autoAllow',
    'archived',
    'engineRefs',
    'lastEngine',
    'pid',
    'msgCount',
    'queued',
    'contextReset',
    'hubMessages',
  ],
  unresolvedListOrderRule: 'native-observed-time-vs-hub-activity-and-rename-time',
});

export const NATIVE_DISAPPEARANCE_POLICY = frozen([
  { state: 'running-or-starting', action: 'retain-and-mark-native-unavailable' },
  { state: 'claimed-or-bridged-owner', action: 'retain-claim-and-hub-history' },
  { state: 'has-hub-appended-messages', action: 'retain-hub-session-and-messages' },
  { state: 'standalone-idle-unclaimed-no-hub-messages', action: 'remove-after-complete-error-free-scan' },
]);

export const ATOMIC_PUBLISH_CONTRACT = frozen({
  candidateIsIsolatedUntilPublish: true,
  getWebsocketResumeAndBridgeReadPreviousSnapshotUntilPublish: true,
  candidateContainsOnlyNativeDerivedDelta: true,
  hubOwnedMutationsAdvanceGeneration: true,
  publishRebasesNativeDeltaOntoLatestHubRecord: true,
  disappearanceIsReevaluatedAtPublishTime: true,
  scannerNeverClearsEngineRefs: true,
  partialFailureCannotPublishFalseDeletion: true,
});

// Finalized by the 2026-08-05 batch-1 synthetic baseline. These are target
// ceilings for later optimization batches, not assertions that the synchronous
// baseline already passes every target.
export const SESSION_REFRESH_SLO = frozen({
  getSessionsP95Ms: 100,
  heartbeat: { intervalMultiplier: 2, allowanceMs: 250 },
  eventLoopDelayP95Ms: 50,
  eventLoopDelayMaxMs: 200,
  peakRss: { baseAllowanceBytes: 64 * 1024 * 1024, largestFileMultiplier: 4 },
  thousandSessionMetadata: {
    materializationMs: 20,
    httpJsonSerializationMs: 25,
    websocketJsonStringifyMs: 25,
    payloadBytesMustBeRecorded: true,
  },
});

export function validateNativeScanResult(result) {
  const issues = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, issues: ['scan result must be an object'] };
  }
  for (const key of NATIVE_SCAN_RESULT_CONTRACT.requiredKeys) {
    if (!Object.hasOwn(result, key)) issues.push(`missing ${key}`);
  }
  if (typeof result.complete !== 'boolean') issues.push('complete must be boolean');
  for (const key of ['entries', 'seenPaths', 'errors', 'rootsScanned']) {
    if (!Array.isArray(result[key])) issues.push(`${key} must be an array`);
  }
  if (Array.isArray(result.errors)) {
    result.errors.forEach((error, index) => {
      if (!error || typeof error !== 'object' || Array.isArray(error)) {
        issues.push(`errors[${index}] must be an object`);
        return;
      }
      for (const key of NATIVE_SCAN_RESULT_CONTRACT.errorRequiredKeys) {
        if (!Object.hasOwn(error, key)) issues.push(`errors[${index}] missing ${key}`);
      }
      for (const key of NATIVE_SCAN_RESULT_CONTRACT.forbiddenErrorKeys) {
        if (Object.hasOwn(error, key)) issues.push(`errors[${index}] exposes ${key}`);
      }
    });
  }
  return { ok: issues.length === 0, issues };
}
