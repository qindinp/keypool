export function pickUpstream(registry) {
  return registry.choose();
}

export function listFallbackUpstreams(registry, excludedAccountIds = []) {
  const excluded = new Set(excludedAccountIds);
  return registry.listCandidates().filter(item => !excluded.has(item.accountId));
}
