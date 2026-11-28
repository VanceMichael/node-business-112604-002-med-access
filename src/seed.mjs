import { randomUUID } from 'node:crypto';
import { digest } from './util.mjs';
import { billKey, bindingKey } from './domain.mjs';

export function blankState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    cursorSecret: randomUUID(),
    requests: {},
    bindings: {},
    settlements: {},
    reversals: {},
    coverage: {},
    grants: {},
    deliveries: {},
    receipts: {},
    notifications: {},
    disclosures: [],
  };
}

/**
 * 从静态领域目录建立初始状态。
 *
 * 目录中的两家机构可以使用同一个本地人员号 `p17`，也可以使用同一个单据号；
 * 这里始终以 source 作为命名空间的一部分，不做跨机构合并。
 */
export function createInitialState(catalog, at = new Date().toISOString()) {
  const state = blankState();
  state.createdAt = at;
  for (const source of catalog.sources || []) {
    state.coverage[source.id] = { source: source.id, through: source.coverageThrough || null, updatedAt: at };
  }
  for (const settlement of catalog.settlements || []) {
    const business = {
      source: settlement.source,
      bill: settlement.bill,
      revision: settlement.revision,
      date: settlement.date,
      localPerson: settlement.localPerson,
      lines: structuredClone(settlement.lines),
    };
    const key = `${billKey(settlement.source, settlement.bill)}\u0000${settlement.revision}`;
    state.settlements[key] = {
      ...business,
      digest: digest(business),
      receivedAt: at,
      requestId: 'catalog',
    };
  }
  for (const correction of catalog.corrections || []) {
    const candidates = Object.values(state.settlements)
      .filter(item => item.source === correction.source
        && item.bill === correction.bill
        && item.revision < correction.revision)
      .sort((a, b) => b.revision - a.revision);
    const original = candidates[0];
    if (!original) continue;
    const business = {
      source: correction.source,
      bill: correction.bill,
      revision: correction.revision,
      originalRevision: original.revision,
      reverses: structuredClone(correction.reverses),
    };
    const key = `${billKey(correction.source, correction.bill)}\u0000${correction.revision}`;
    state.reversals[key] = {
      ...business,
      digest: digest(business),
      receivedAt: at,
      requestId: 'catalog',
    };
  }
  for (const binding of catalog.bindings || []) {
    const confirmed = binding.confirmed !== false;
    const entry = {
      revision: 1,
      person: binding.person,
      confirmed,
      at,
      requestId: 'catalog',
      digest: digest({ source: binding.source, localPerson: binding.localPerson, revision: 1, person: binding.person, confirmed }),
    };
    state.bindings[bindingKey(binding.source, binding.localPerson)] = {
      source: binding.source,
      localPerson: binding.localPerson,
      currentRevision: 1,
      revisions: { 1: entry },
    };
  }
  return state;
}

export { billKey, bindingKey };
