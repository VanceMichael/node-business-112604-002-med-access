import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, as } from '../support/fixtures.mjs';

const grant = (service, overrides = {}) => service.createGrant(as('person-a'), {
  requestId: 'intake-grant', hospital: 'hospital-a', doctor: 'doctor-1', visit: 'visit-a',
  range: ['2026-01-01', '2026-12-31'], expiresAt: '2026-11-25T18:00:00Z',
  ...overrides,
});

test('来源端只能投送本机构数据，覆盖日期不能回退', async t => {
  const { service } = await makeService(t);
  const clinic = as('clinic-a-intake');

  await assert.rejects(
    service.intakeSettlement(clinic, {
      requestId: 'wrong-source', source: 'pharmacy-b', bill: 'bill-x', revision: 1,
      date: '2026-11-22', localPerson: 'p1', lines: [{ line: '1', drug: 'd', amountMinor: 1 }],
    }),
    error => error.status === 403 && error.code === 'source_mismatch',
  );

  const advanced = await service.intakeCoverage(clinic, { requestId: 'cov-1', through: '2026-11-25' });
  assert.equal(advanced.through, '2026-11-25');
  await assert.rejects(
    service.intakeCoverage(clinic, { requestId: 'cov-2', through: '2026-11-24' }),
    error => error.status === 409 && error.code === 'coverage_regression',
  );
  // 其他来源的覆盖日期不受影响。
  const pharmacy = await service.intakeCoverage(as('pharmacy-b-intake'), { requestId: 'cov-3', through: '2026-11-24' });
  assert.equal(pharmacy.through, '2026-11-24');
});

test('医生端标注覆盖日期，不把未更新日期当成没有购药', async t => {
  const { service } = await makeService(t);
  const created = await grant(service);
  const read = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId });
  // 查询区间到 2026-12-31，来源只更新到 11-23/11-24。
  assert.equal(read.coverage.complete, false);
  assert.equal(read.coverage.rangedTo, '2026-12-31');
  assert.match(read.warnings.join('\n'), /未覆盖日期不代表没有购药/);
  for (const line of read.lines) {
    assert.equal(line.coverageThrough, '2026-11-24');
    assert.ok(line.source === 'clinic-a');
    assert.ok(Number.isInteger(line.revision));
  }

  await service.intakeCoverage(as('clinic-a-intake'), { requestId: 'c-a', through: '2026-12-31' });
  await service.intakeCoverage(as('pharmacy-b-intake'), { requestId: 'c-b', through: '2026-12-31' });
  const updated = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId });
  assert.equal(updated.coverage.complete, true);
  assert.deepEqual(updated.warnings, []);
});

test('结算更正必须引用原单版本，且版本不能跳号或改内容', async t => {
  const { service } = await makeService(t);
  const clinic = as('clinic-a-intake');
  const base = {
    bill: 'bill-30', date: '2026-11-21', localPerson: 'p40',
    lines: [{ line: '1', drug: 'synthetic-f', amountMinor: 700 }],
  };
  await service.intakeSettlement(clinic, { requestId: 's30-1', revision: 1, ...base });

  await assert.rejects(
    service.intakeSettlement(clinic, { requestId: 's30-2', revision: 2, ...base }),
    error => error.status === 400 && error.code === 'invalid_revision',
  );
  await assert.rejects(
    service.intakeSettlement(clinic, {
      requestId: 's30-3', revision: 2, previousRevision: 99, ...base,
      lines: [{ line: '1', drug: 'synthetic-f', amountMinor: 650 }],
    }),
    error => error.status === 409 && error.code === 'original_missing',
  );
  await assert.rejects(
    service.intakeSettlement(clinic, {
      requestId: 's30-4', revision: 3, previousRevision: 1, ...base,
    }),
    error => error.status === 409 && error.code === 'stale_revision',
  );
  const corrected = await service.intakeSettlement(clinic, {
    requestId: 's30-5', revision: 2, previousRevision: 1, ...base,
    lines: [{ line: '1', drug: 'synthetic-f', amountMinor: 650 }],
  });
  assert.equal(corrected.settlement.revision, 2);
  assert.equal(corrected.settlement.previousRevision, 1);
});

test('冲销必须引用原单行，累计不得超过原金额', async t => {
  const { service } = await makeService(t);
  const clinic = as('clinic-a-intake');
  await service.intakeBinding(clinic, {
    requestId: 'b40', localPerson: 'p40', person: 'person-b', confirmed: true,
  });
  await service.intakeSettlement(clinic, {
    requestId: 's40', bill: 'bill-40', revision: 1, date: '2026-11-21', localPerson: 'p40',
    lines: [{ line: '1', drug: 'synthetic-g', amountMinor: 1000 }],
  });

  await assert.rejects(
    service.intakeReversal(clinic, {
      requestId: 'r40-a', bill: 'bill-40', revision: 2, originalRevision: 1,
      reverses: [{ line: '9', amountMinor: 10 }],
    }),
    error => error.status === 409 && error.code === 'line_missing',
  );
  await assert.rejects(
    service.intakeReversal(clinic, {
      requestId: 'r40-b', bill: 'bill-40', revision: 2, originalRevision: 1,
      reverses: [{ line: '1', amountMinor: 1001 }],
    }),
    error => error.status === 409 && error.code === 'amount_exceeds_line',
  );
  const partial = await service.intakeReversal(clinic, {
    requestId: 'r40-c', bill: 'bill-40', revision: 2, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 400 }],
  });
  assert.equal(partial.reversal.reverses[0].amountMinor, 400);

  await assert.rejects(
    service.intakeReversal(clinic, {
      requestId: 'r40-d', bill: 'bill-40', revision: 3, originalRevision: 1,
      reverses: [{ line: '1', amountMinor: 601 }],
    }),
    error => error.status === 409 && error.code === 'amount_exceeds_line',
  );
  const rest = await service.intakeReversal(clinic, {
    requestId: 'r40-e', bill: 'bill-40', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 600 }],
  });
  assert.equal(rest.reversal.revision, 3);

  const view = service.patientRecords(as('person-b'));
  const bill = view.reversed.find(item => item.bill === 'bill-40');
  assert.ok(bill, '全额冲销后进入已冲销区');
  assert.equal(bill.lines[0].reversedAmountMinor, 1000);
  assert.equal(bill.lines[0].netAmountMinor, 0);
});

test('待核资料停在待核区，确认后才进入有效区；确认前不可见给医生', async t => {
  const { service } = await makeService(t);
  const pharmacy = as('pharmacy-b-intake');
  await service.intakeBinding(pharmacy, {
    requestId: 'p50-bind', localPerson: 'p50', person: 'person-a', confirmed: false,
  });
  await service.intakeSettlement(pharmacy, {
    requestId: 'p50-settle', bill: 'bill-50', revision: 1, date: '2026-11-22', localPerson: 'p50',
    lines: [{ line: '1', drug: 'synthetic-h', amountMinor: 300 }],
  });
  const created = await grant(service);
  const read = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId });
  assert.equal(read.lines.some(line => line.bill === 'bill-50'), false);
  const pending = service.patientRecords(as('person-a')).pending;
  assert.equal(pending.some(item => item.bill === 'bill-50'), true);

  await service.intakeBinding(pharmacy, {
    requestId: 'p50-confirm', localPerson: 'p50', person: 'person-a', confirmed: true, revision: 2,
  });
  const after = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId });
  assert.equal(after.lines.some(line => line.bill === 'bill-50'), true);
  assert.equal(service.patientRecords(as('person-a')).pending.length, 0);

  // 来源端也能看到本机构的待核清单。
  await service.intakeBinding(pharmacy, {
    requestId: 'p51-bind', localPerson: 'p51', person: null, confirmed: false,
  });
  await service.intakeSettlement(pharmacy, {
    requestId: 'p51-settle', bill: 'bill-51', revision: 1, date: '2026-11-23', localPerson: 'p51',
    lines: [{ line: '1', drug: 'synthetic-i', amountMinor: 100 }],
  });
  const sourceState = service.sourceState(pharmacy);
  assert.equal(sourceState.pending.length, 1);
  assert.equal(sourceState.pending[0].localPerson, 'p51');
  // 待核资料不进入任何患者视图，也不出现在医生可见范围。
  assert.equal(service.patientRecords(as('person-a')).pending.some(item => item.bill === 'bill-51'), false);
  assert.equal(service.patientRecords(as('person-c')).valid.length, 0);
});

test('同号单据按来源区分，归属也只在本来源内生效', async t => {
  const { service } = await makeService(t);
  // 药店 bill-8 属于 person-b，诊所 bill-8 属于 person-a。
  const a = service.patientRecords(as('person-a')).valid;
  const b = service.patientRecords(as('person-b')).valid;
  assert.deepEqual(a.map(item => [item.source, item.bill]), [['clinic-a', 'bill-8']]);
  assert.deepEqual(b.map(item => [item.source, item.bill]), [['pharmacy-b', 'bill-8']]);
  assert.equal(a[0].lines.length + b[0].lines.length, 3);
  assert.equal(JSON.stringify(a).includes('synthetic-c'), false);
  assert.equal(JSON.stringify(b).includes('synthetic-a'), false);

  // 只给 pharmacy-b 的一个新本地人员号绑定 person-a，不影响 clinic-a 的 p17。
  await service.intakeBinding(as('pharmacy-b-intake'), {
    requestId: 'cross-bind', localPerson: 'p17', person: 'person-a', confirmed: true, revision: 2,
  });
  const after = service.patientRecords(as('person-a')).valid;
  assert.deepEqual(
    after.map(item => [item.source, item.bill]).sort(),
    [['clinic-a', 'bill-8'], ['pharmacy-b', 'bill-8']],
  );
  assert.equal(service.patientRecords(as('person-b')).valid.length, 0);
});
