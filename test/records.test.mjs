import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, as } from '../support/fixtures.mjs';

const grantBody = (overrides = {}) => ({
  requestId: 'g-1',
  hospital: 'hospital-a',
  doctor: 'doctor-1',
  visit: 'visit-a',
  range: ['2026-01-01', '2026-12-31'],
  expiresAt: '2026-11-25T18:00:00Z',
  ...overrides,
});

test('患者记录区分有效、已冲销与待核，且不跨机构合并同号单据', async t => {
  const { service, store } = await makeService(t);
  const patient = as('person-a');

  const initial = service.patientRecords(patient);
  assert.deepEqual(initial.valid.map(item => [item.source, item.bill]), [['clinic-a', 'bill-8']]);
  assert.deepEqual(initial.reversed, []);
  assert.deepEqual(initial.pending, []);
  const line2 = initial.valid[0].lines.find(line => line.line === '2');
  assert.equal(line2.reversedAmountMinor, 600);
  assert.equal(line2.netAmountMinor, 1200);

  // 另一家机构使用同一个本地人员号 p17 和同一个单据号，但属于另一患者。
  const other = service.patientRecords(as('person-b'));
  assert.deepEqual(other.valid.map(item => [item.source, item.bill]), [['pharmacy-b', 'bill-8']]);

  // 整单冲销进入已冲销区，部分冲销仍留在有效区并标出金额。
  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'rev-2', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });
  const after = service.patientRecords(patient);
  const clinic = after.valid.find(item => item.source === 'clinic-a');
  assert.ok(clinic, '部分冲销的整单仍在有效区');
  assert.equal(clinic.lines.find(line => line.line === '1').status, 'reversed');

  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'rev-3', bill: 'bill-8', revision: 4, originalRevision: 1,
    reverses: [{ line: '2', amountMinor: 1200 }],
  });
  const fully = service.patientRecords(patient);
  assert.equal(fully.valid.length, 0);
  assert.deepEqual(fully.reversed.map(item => [item.source, item.bill]), [['clinic-a', 'bill-8']]);

  // 待核归属只露面单摘要，不给药品明细，也不进医生可见范围。
  await service.intakeBinding(as('pharmacy-b-intake'), {
    requestId: 'bind-pending', localPerson: 'p18', person: 'person-c', confirmed: false,
  });
  await service.intakeSettlement(as('pharmacy-b-intake'), {
    requestId: 'pend-1', bill: 'bill-9', revision: 1, date: '2026-11-21',
    localPerson: 'p18', lines: [{ line: '1', drug: 'synthetic-d', amountMinor: 500 }],
  });
  const pendingView = service.patientRecords(as('person-c'));
  assert.equal(pendingView.pending.length, 1);
  assert.equal(pendingView.pending[0].status, 'pending_review');
  assert.equal(pendingView.pending[0].lines, undefined);
  assert.equal(pendingView.valid.length, 0);
  assert.ok(!JSON.stringify(pendingView.pending).includes('synthetic-d'));
  void store;
});

test('同一次结算重复投送不重复计费，不同版本按来源版本递增', async t => {
  const { service } = await makeService(t);
  const intake = as('pharmacy-b-intake');
  const payload = {
    requestId: 'settle-1', bill: 'bill-20', revision: 1, date: '2026-11-22',
    localPerson: 'p30', lines: [{ line: '1', drug: 'synthetic-e', amountMinor: 900 }],
  };
  const first = await service.intakeSettlement(intake, payload);
  assert.equal(first.duplicate, false);
  const repeated = await service.intakeSettlement(intake, payload);
  assert.equal(repeated.duplicate, true);

  // 同号不同内容不能覆盖。
  await assert.rejects(
    service.intakeSettlement(intake, { ...payload, date: '2026-11-23' }),
    error => error.status === 409 && error.code === 'request_id_conflict',
  );
  // 新请求号但内容相同视为同一版本的重投，不重复计费。
  const resent = await service.intakeSettlement(intake, { ...payload, requestId: 'settle-1b' });
  assert.equal(resent.duplicate, true);
  assert.equal(resent.counted, true);

  const patient = as('person-b');
  await service.intakeBinding(intake, {
    requestId: 'bind-30', localPerson: 'p30', person: 'person-b', confirmed: true,
  });
  const view = service.patientRecords(patient);
  assert.equal(view.valid.filter(item => item.source === 'pharmacy-b').length, 2);
  const total = view.valid
    .filter(item => item.source === 'pharmacy-b')
    .reduce((sum, item) => sum + item.amountMinor, 0);
  assert.equal(total, 3200 + 900, '重复投送不应重复计费');

  await assert.rejects(
    service.intakeSettlement(intake, { ...payload, requestId: 'settle-3', revision: 3, previousRevision: 1 }),
    error => error.status === 409 && error.code === 'stale_revision',
  );
});

test('归属纠正后原患者不再看到，正确患者可见，已披露事实仍可追查', async t => {
  const { service } = await makeService(t);
  const doctor = as('doctor-1');
  const patient = as('person-a');
  const created = await service.createGrant(patient, grantBody({ requestId: 'g-bind' }));
  const grantId = created.grant.grantId;

  const page1 = await service.doctorRead(doctor, { grantId, pageSize: '1' });
  assert.equal(page1.totalLines, 2);
  assert.equal(page1.complete, false);

  const correction = await service.intakeBinding(as('clinic-a-intake'), {
    requestId: 'bind-fix', localPerson: 'p17', person: 'person-b', confirmed: true, revision: 2,
  });
  assert.equal(correction.binding.status, 'confirmed');

  // 原文属错误绑定：原患者的新查询看不到，正确患者看得到。
  const oldPatient = service.patientRecords(patient);
  assert.equal(oldPatient.valid.some(item => item.source === 'clinic-a'), false);
  const rightPatient = service.patientRecords(as('person-b'));
  assert.equal(rightPatient.valid.some(item => item.source === 'clinic-a'), true);

  // 已返回的那一页不能随纠正被改写成从未发生。
  const detail = service.deliveryDetail(doctor, page1.deliveryId);
  assert.equal(detail.pages[0].lines[0].source, 'clinic-a');
  assert.equal(detail.disclosed.length, 1);

  // 但该次分段读取不能继续，也不能把旧页和新页拼成当前清单。
  await assert.rejects(
    service.doctorRead(doctor, { grantId, cursor: page1.nextCursor }),
    error => error.status === 409 && error.code === 'visible_scope_changed',
  );
  const interrupted = service.deliveryDetail(doctor, page1.deliveryId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.pages.length, 1);

  // 患者仍能查看自己向哪次就诊开放过什么范围，以及已披露过哪些行。
  const view = service.patientGrants(patient).grants.find(item => item.grantId === grantId);
  assert.equal(view.disclosure.lines, 1);
  assert.equal(view.disclosure.lineRefs[0].source, 'clinic-a');
  assert.equal(view.disclosure.lineRefs[0].drug, undefined, '披露追溯只保留来源行，不复制药品详情');
});
