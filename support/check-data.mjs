import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const load = async name => JSON.parse(await readFile(new URL('../data/' + name, import.meta.url)));
const catalog = await load('catalog.json');
const records = await load('records.json');
const peer = await load('peer.json');
const actors = await load('actors.json');
assert.equal(catalog.synthetic, true, '资料需明确为合成数据');
assert.equal(records.synthetic, true, '记录需明确为合成数据');
assert.equal(actors.synthetic, true, '身份目录需明确为合成数据');
assert.ok(records.records.length > 0, '业务记录不可为空');
assert.equal(new Set(records.records.map(r => r.recordId)).size, records.records.length, '记录编号不可重复');
for (const record of records.records) { assert.equal(typeof record.kind, 'string'); assert.equal(typeof record.payload, 'object'); }
assert.ok(peer.operations.length > 0, '联调操作不可为空');
assert.equal(new Set(peer.operations).size, peer.operations.length, '联调操作不可重复');
for (const b of catalog.settlements) assert.ok(catalog.sources.some(s => s.id === b.source), '结算来源需存在');
for (const c of catalog.corrections) assert.ok(catalog.settlements.some(b => b.source === c.source && b.bill === c.bill), '冲销需有原单');
// 各来源的版本在来源内部比较：同一 source + bill 的版本不可重复，冲销版本必须晚于原单。
const billKeys = new Set();
for (const b of catalog.settlements) {
  const key = b.source + '\0' + b.bill + '\0' + b.revision;
  assert.ok(!billKeys.has(key), '同一来源单据版本不可重复');
  billKeys.add(key);
  assert.ok(b.lines.every((line, index) => b.lines.findIndex(other => other.line === line.line) === index), '单内行号不可重复');
}
for (const c of catalog.corrections) {
  const original = catalog.settlements.find(b => b.source === c.source && b.bill === c.bill && b.revision < c.revision);
  assert.ok(original, '冲销版本必须晚于原单版本');
  for (const item of c.reverses) {
    const line = original.lines.find(entry => entry.line === item.line);
    assert.ok(line, '冲销行必须存在于原单');
    assert.ok(item.amountMinor <= line.amountMinor, '冲销金额不得超过原行金额');
  }
}
// 本地人员号只在本来源内有效：不同来源可以复用，绑定不得跨来源合并。
assert.equal(new Set(actors.actors.map(a => a.id)).size, actors.actors.length, '身份编号不可重复');
assert.equal(new Set(actors.actors.map(a => a.token)).size, actors.actors.length, '身份令牌不可重复');
for (const binding of catalog.bindings) {
  assert.ok(actors.actors.some(a => a.id === binding.person && a.role === 'patient'), '绑定患者需存在于身份目录');
}
console.log('合成资料格式及领域引用核查通过');
