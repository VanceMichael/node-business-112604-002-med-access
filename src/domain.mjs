import { digest } from './util.mjs';

export const bindingKey = (source, localPerson) => `${source}\u0000${localPerson}`;
export const billKey = (source, bill) => `${source}\u0000${bill}`;
export const lineKey = (source, bill, line) => `${source}\u0000${bill}\u0000${line}`;

/** 当前绑定取同一来源本地人员号下修订号最高的一条，不跨来源比较版本。 */
export function currentBinding(state, source, localPerson) {
  const record = state.bindings[bindingKey(source, localPerson)];
  if (!record || record.currentRevision === null || record.currentRevision === undefined) {
    return { source, localPerson, person: null, revision: null, confirmed: false, status: 'unbound' };
  }
  const entry = record.revisions[record.currentRevision];
  if (!entry) {
    return { source, localPerson, person: null, revision: null, confirmed: false, status: 'unbound' };
  }
  const confirmed = entry.confirmed !== false;
  return {
    source, localPerson,
    person: entry.person,
    revision: entry.revision,
    confirmed,
    status: confirmed ? 'confirmed' : 'pending',
  };
}

export function bindingHistory(state, source, localPerson) {
  const record = state.bindings[bindingKey(source, localPerson)];
  if (!record) return [];
  return Object.values(record.revisions).sort((a, b) => a.revision - b.revision);
}

/** 结算按 source + bill 归组；同号不同来源是两张单据。 */
export function billGroups(state) {
  const groups = new Map();
  for (const settlement of Object.values(state.settlements)) {
    const key = billKey(settlement.source, settlement.bill);
    let group = groups.get(key);
    if (!group) {
      group = { source: settlement.source, bill: settlement.bill, settlements: [], reversals: [] };
      groups.set(key, group);
    }
    group.settlements.push(settlement);
  }
  for (const reversal of Object.values(state.reversals)) {
    const group = groups.get(billKey(reversal.source, reversal.bill));
    if (group) group.reversals.push(reversal);
  }
  for (const group of groups.values()) {
    group.settlements.sort((a, b) => a.revision - b.revision);
    group.base = group.settlements[group.settlements.length - 1];
    group.reversals.sort((a, b) => a.revision - b.revision);
  }
  return groups;
}

export function groupForBill(state, source, bill) {
  return billGroups(state).get(billKey(source, bill)) || null;
}

/** 金额与版本都按来源行累计；reverses 是冲销金额而不是剩余金额。 */
export function billLines(group) {
  const { base, reversals } = group;
  const reversedByLine = new Map();
  const revisionByLine = new Map();
  for (const reversal of reversals) {
    for (const item of reversal.reverses) {
      reversedByLine.set(item.line, (reversedByLine.get(item.line) || 0) + item.amountMinor);
      revisionByLine.set(item.line, Math.max(revisionByLine.get(item.line) || 0, reversal.revision));
    }
  }
  return base.lines.map(line => {
    const reversedAmountMinor = Math.min(line.amountMinor, reversedByLine.get(line.line) || 0);
    const netAmountMinor = Math.max(0, line.amountMinor - reversedAmountMinor);
    return {
      source: group.source,
      bill: group.bill,
      line: line.line,
      date: base.date,
      drug: line.drug,
      amountMinor: line.amountMinor,
      reversedAmountMinor,
      netAmountMinor,
      revision: Math.max(base.revision, revisionByLine.get(line.line) || 0),
      baseRevision: base.revision,
      localPerson: base.localPerson,
      status: netAmountMinor > 0 ? 'active' : 'reversed',
    };
  });
}

export function coverageList(state) {
  return Object.values(state.coverage)
    .map(item => ({ source: item.source, through: item.through || null }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

export function coverageFor(state, source) {
  return state.coverage[source]?.through || null;
}

export function coverageSummary(state, rangeEnd, rangeStart) {
  const sources = coverageList(state);
  const complete = Boolean(rangeEnd)
    && sources.length > 0
    && sources.every(item => item.through && item.through >= rangeEnd);
  const dated = sources.map(item => item.through).filter(Boolean).sort();
  const outdated = Boolean(rangeEnd)
    && sources.some(item => !item.through || item.through < rangeEnd);
  return {
    sources,
    complete,
    rangedFrom: rangeStart || null,
    rangedTo: rangeEnd || null,
    earliest: dated[0] || null,
    note: outdated
      ? '部分来源的资料尚未更新到查询区间末尾；未覆盖日期不代表没有购药。'
      : null,
  };
}

/** 患者自己的记录：有效、整单已冲销、待核各一组。 */
export function patientView(state, person) {
  const valid = [];
  const reversed = [];
  const pending = [];
  for (const group of billGroups(state).values()) {
    const base = group.base;
    const binding = currentBinding(state, group.source, base.localPerson);
    if (binding.person !== person) continue;
    if (!binding.confirmed) {
      pending.push({
        source: group.source,
        bill: group.bill,
        date: base.date,
        lineCount: base.lines.length,
        status: 'pending_review',
        reason: 'attribution_pending',
        coverageThrough: coverageFor(state, group.source),
        note: '归属尚未确认，暂不展示药品明细，也不会提供给接诊医生。',
      });
      continue;
    }
    const lines = billLines(group);
    const activeLines = lines.filter(line => line.status === 'active');
    const bill = {
      source: group.source,
      bill: group.bill,
      date: base.date,
      revision: base.revision,
      coverageThrough: coverageFor(state, group.source),
      lineCount: lines.length,
      amountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
      reversedAmountMinor: lines.reduce((sum, line) => sum + line.reversedAmountMinor, 0),
      netAmountMinor: lines.reduce((sum, line) => sum + line.netAmountMinor, 0),
      lines,
    };
    if (activeLines.length > 0) {
      valid.push({ ...bill, status: activeLines.length === lines.length ? 'valid' : 'partially_reversed' });
    } else {
      reversed.push({ ...bill, status: 'reversed' });
    }
  }
  const sort = (a, b) => (b.date + b.source + b.bill).localeCompare(a.date + a.source + a.bill);
  valid.sort(sort); reversed.sort(sort); pending.sort(sort);
  return { valid, reversed, pending, coverage: coverageSummary(state, null).sources };
}

/**
 * 医生可见行：必须归属已确认的本人、单据日期落在授权区间、且当前未全额冲销。
 * 返回内部快照字段，既用于分页，也用于导入确认追溯当时看到的版本。
 */
export function doctorVisibleLines(state, person, range) {
  const lines = [];
  for (const group of billGroups(state).values()) {
    const base = group.base;
    const binding = currentBinding(state, group.source, base.localPerson);
    if (!binding.confirmed || binding.person !== person) continue;
    if (base.date < range[0] || base.date > range[1]) continue;
    const coverageThrough = coverageFor(state, group.source);
    for (const line of billLines(group)) {
      if (line.status !== 'active') continue;
      lines.push({
        source: line.source,
        bill: line.bill,
        line: line.line,
        date: line.date,
        drug: line.drug,
        amountMinor: line.amountMinor,
        reversedAmountMinor: line.reversedAmountMinor,
        netAmountMinor: line.netAmountMinor,
        revision: line.revision,
        baseRevision: line.baseRevision,
        coverageThrough,
        localPerson: base.localPerson,
        bindingPerson: binding.person,
        bindingRevision: binding.revision,
        status: 'active',
      });
    }
  }
  lines.sort((a, b) =>
    (a.source + a.bill + a.line).localeCompare(b.source + b.bill + b.line));
  return lines;
}

export const lineFingerprint = lines => digest(lines);

export function lineView(line) {
  return {
    source: line.source,
    bill: line.bill,
    line: line.line,
    date: line.date,
    drug: line.drug,
    amountMinor: line.amountMinor,
    reversedAmountMinor: line.reversedAmountMinor,
    netAmountMinor: line.netAmountMinor,
    revision: line.revision,
    coverageThrough: line.coverageThrough,
    status: line.status,
  };
}

/** 当前某来源行的版本与冲销状态，用于发现迟到冲销/更正。 */
export function lineState(state, source, bill, line) {
  const group = groupForBill(state, source, bill);
  if (!group) return null;
  const found = billLines(group).find(item => item.line === line);
  if (!found) return null;
  const binding = currentBinding(state, source, found.localPerson);
  return { ...found, bindingPerson: binding.person, bindingRevision: binding.revision, bindingStatus: binding.status };
}
