import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, as, fakeDirectory } from '../support/fixtures.mjs';

const grantA = (service, overrides = {}) => service.createGrant(as('person-a'), {
  requestId: 'keep-grant-a', hospital: 'hospital-a', doctor: 'doctor-1', visit: 'visit-a',
  range: ['2026-01-01', '2026-12-31'], expiresAt: '2026-11-25T18:00:00Z',
  ...overrides,
});

/** 医院完成一页读取并确认导入其中全部行。 */
async function readAndImport(service, grantId, { pageSize = '10', page } = {}) {
  const read = await service.doctorRead(as('doctor-1'), { grantId, pageSize, ...(page ? { cursor: page } : {}) });
  const receipt = await service.hospitalReceipt(as('hospital-a-records'), {
    requestId: `receipt-${read.deliveryId}-${read.page}`,
    deliveryId: read.deliveryId,
    lines: read.lines.map(line => ({
      source: line.source, bill: line.bill, line: line.line, revision: line.revision,
    })),
  });
  return { read, receipt };
}

test('导入确认只接受实际返回过的行，且不能恢复查询权限', async t => {
  const { service } = await makeService(t);
  const created = await grantA(service);
  const grantId = created.grant.grantId;
  const { read } = await readAndImport(service, grantId);

  // 未返回过的行不能确认。
  await assert.rejects(
    service.hospitalReceipt(as('hospital-a-records'), {
      requestId: 'fake-line', deliveryId: read.deliveryId,
      lines: [{ source: 'pharmacy-b', bill: 'bill-8', line: '1', revision: 1 }],
    }),
    error => error.status === 409 && error.code === 'line_not_disclosed',
  );
  // 伪造版本不能确认。
  await assert.rejects(
    service.hospitalReceipt(as('hospital-a-records'), {
      requestId: 'fake-revision', deliveryId: read.deliveryId,
      lines: [{ source: 'clinic-a', bill: 'bill-8', line: '1', revision: 99 }],
    }),
    error => error.status === 409 && error.code === 'line_revision_mismatch',
  );
  // 别家医院不能替本院确认。
  await assert.rejects(
    service.hospitalReceipt(as('hospital-b-records'), {
      requestId: 'other-hospital', deliveryId: read.deliveryId,
      lines: [{ source: 'clinic-a', bill: 'bill-8', line: '1', revision: 1 }],
    }),
    error => error.status === 403 && error.code === 'hospital_mismatch',
  );

  // 撤回后仍可完成已经开始的那次接收确认。
  await service.revokeGrant(as('person-a'), grantId, { requestId: 'revoke-after-read' });
  await assert.rejects(
    service.doctorRead(as('doctor-1'), { grantId }),
    error => error.status === 403 && error.code === 'grant_revoked',
  );
  const late = await service.hospitalReceipt(as('hospital-a-records'), {
    requestId: 'receipt-after-revoke', deliveryId: read.deliveryId,
    lines: read.lines.map(line => ({ source: line.source, bill: line.bill, line: line.line, revision: line.revision })),
  });
  assert.equal(late.receipt.lines.length, 2);

  // 确认不恢复查询。
  await assert.rejects(
    service.doctorRead(as('doctor-1'), { grantId }),
    error => error.status === 403 && error.code === 'grant_revoked',
  );
});

test('迟到冲销：已导入行产生面向接收医院的更正通知，按通知编号回执', async t => {
  const { service } = await makeService(t);
  const created = await grantA(service);
  const grantId = created.grant.grantId;
  const { read } = await readAndImport(service, grantId);
  assert.equal(read.lines.length, 2);

  const reversal = await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'late-reversal', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });
  assert.ok(reversal.notifications.length >= 1, '迟到冲销应产生更正通知');

  const inbox = service.notificationsFor(as('hospital-a-records'));
  const notification = inbox.notifications.find(item => item.line === '1' && item.kind === 'reversal');
  assert.ok(notification, '医院甲应收到第 1 行的冲销更正');
  assert.equal(notification.currentRevision, 3);
  assert.equal(notification.importedRevision, 1);
  assert.equal(notification.currentStatus, 'reversed');

  // 通知本身不含患者身份与药品名称。
  assert.equal(notification.person, undefined);
  assert.equal(notification.drug, undefined);
  assert.equal(JSON.stringify(notification).includes('synthetic-a'), false);
  assert.equal(JSON.stringify(notification).includes('person-a'), false);

  const ack = await service.acknowledgeNotification(
    as('hospital-a-records'), notification.notificationId, { requestId: 'ack-1' },
  );
  assert.equal(ack.status, 'acknowledged');
  const repeated = await service.acknowledgeNotification(
    as('hospital-a-records'), notification.notificationId, { requestId: 'ack-2' },
  );
  assert.equal(repeated.acknowledgedAt, ack.acknowledgedAt, '回执不重复改写时间');
  assert.equal(service.notificationsFor(as('hospital-a-records')).notifications
    .find(item => item.notificationId === notification.notificationId).status, 'acknowledged');
});

test('无权接收原记录的医院不能借更正通知获得患者身份或药品详情', async t => {
  const directory = fakeDirectory();
  directory.doctors.get('hospital-b').set('doctor-9', {
    doctorId: 'doctor-9', hospitalId: 'hospital-b', active: true,
  });
  directory.visits.set('visit-a', { visitId: 'visit-a', personId: 'person-a', doctorId: 'doctor-9', open: true });
  const { service } = await makeService(t, { directory });
  const created = await grantA(service, { doctor: 'doctor-9', hospital: 'hospital-b', requestId: 'grant-b' });
  await readAndImportB(service, created.grant.grantId);
  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'late-reversal-b', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });

  assert.equal(service.notificationsFor(as('hospital-a-records')).notifications.length, 0);
  const b = service.notificationsFor(as('hospital-b-records')).notifications;
  assert.equal(b.length, 1);
  assert.equal(JSON.stringify(b).includes('person-a'), false);
  assert.equal(JSON.stringify(b).includes('synthetic-a'), false);
  await assert.rejects(
    service.acknowledgeNotification(as('hospital-a-records'), b[0].notificationId, { requestId: 'wrong-ack' }),
    error => error.status === 404,
  );
});

async function readAndImportB(service, grantId) {
  const read = await service.doctorRead(as('doctor-9'), { grantId, pageSize: '10' });
  return service.hospitalReceipt(as('hospital-b-records'), {
    requestId: 'receipt-b',
    deliveryId: read.deliveryId,
    lines: read.lines.map(line => ({
      source: line.source, bill: line.bill, line: line.line, revision: line.revision,
    })),
  });
}

test('跨页撤回与迟到冲销相遇：已导入行得到更正，旧页保留、后续页拒绝', async t => {
  const { service } = await makeService(t);
  const created = await grantA(service);
  const grantId = created.grant.grantId;

  // 第一页读取并确认导入，只有一行（第 1 行）。
  const { read: page1 } = await readAndImport(service, grantId, { pageSize: '1' });
  assert.equal(page1.totalLines, 2);
  assert.equal(page1.lines[0].line, '1');

  // 患者撤回，同时来源端迟到冲销第 1 行。
  await service.revokeGrant(as('person-a'), grantId, { requestId: 'revoke-mid-2' });
  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'late-rev-line-1', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });

  // 第二页取回被拒，旧页不被追加，也不能当作完整清单。
  await assert.rejects(
    service.doctorRead(as('doctor-1'), { grantId, cursor: page1.nextCursor }),
    error => error.status === 409 && error.code === 'visible_scope_changed',
  );
  const detail = service.deliveryDetail(as('doctor-1'), page1.deliveryId);
  assert.equal(detail.status, 'interrupted');
  assert.deepEqual(detail.pages.map(page => page.lines.map(line => line.line)), [['1']]);

  // 更正只针对实际导入的第 1 行，且只发给接收医院。
  const notifications = service.notificationsFor(as('hospital-a-records')).notifications;
  assert.deepEqual(notifications.map(item => [item.line, item.kind]), [['1', 'reversal']]);
  assert.equal(service.notificationsFor(as('hospital-b-records')).notifications.length, 0);

  // 回执后仍保留通知编号与接受时间。
  const ack = await service.acknowledgeNotification(
    as('hospital-a-records'), notifications[0].notificationId, { requestId: 'ack-late' },
  );
  assert.equal(ack.status, 'acknowledged');
});

test('状态重启后仍可继续投送、回执与查询', async t => {
  const { service, statePath, reopen } = await makeService(t);
  const created = await grantA(service);
  const { read } = await readAndImport(service, created.grant.grantId);
  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'persist-rev', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });
  const beforeAck = service.notificationsFor(as('hospital-a-records')).notifications;
  assert.equal(beforeAck.length, 1);

  const store = await reopen();
  const { createService } = await import('../src/service.mjs');
  const { ACTORS, fakeDirectory } = await import('../support/fixtures.mjs');
  const restarted = createService({
    store, actors: ACTORS, directory: fakeDirectory(),
    clock: () => new Date('2026-11-25T09:00:00Z'),
  });

  // 重启后通知与送达记录仍在。
  const afterAckList = restarted.notificationsFor(as('hospital-a-records')).notifications;
  assert.equal(afterAckList.length, 1);
  assert.equal(restarted.deliveryDetail(as('doctor-1'), read.deliveryId).status, 'complete');

  // 重启后回执仍可用同一通知编号完成。
  const ack = await restarted.acknowledgeNotification(
    as('hospital-a-records'), beforeAck[0].notificationId, { requestId: 'persist-ack' },
  );
  assert.equal(ack.status, 'acknowledged');

  // 重启后可继续投送新版本。
  const next = await restarted.intakeReversal(as('clinic-a-intake'), {
    requestId: 'persist-rev-2', bill: 'bill-8', revision: 4, originalRevision: 1,
    reverses: [{ line: '2', amountMinor: 1200 }],
  });
  assert.equal(next.reversal.revision, 4);
  assert.equal(restarted.patientRecords(as('person-a')).valid.length, 0);
  void statePath;
});

test('归属改正使已导入行产生改归属通知，且不改写已披露事实', async t => {
  const { service } = await makeService(t);
  const created = await grantA(service);
  const { read } = await readAndImport(service, created.grant.grantId);
  const correction = await service.intakeBinding(as('clinic-a-intake'), {
    requestId: 'bind-to-b', localPerson: 'p17', person: 'person-b', confirmed: true, revision: 2,
  });
  assert.ok(correction.notifications.length >= 1);

  const notification = service.notificationsFor(as('hospital-a-records')).notifications
    .find(item => item.kind === 'reattribution');
  assert.ok(notification);
  assert.equal(notification.person, undefined);
  assert.equal(JSON.stringify(notification).includes('person-b'), false);
  assert.equal(JSON.stringify(notification).includes('bill-8'), true, '需要能定位原来源行');

  // 已披露事实保留为当时的行，不随改归属被重写。
  const detail = service.deliveryDetail(as('doctor-1'), read.deliveryId);
  assert.equal(detail.pages[0].lines.length, 2);
  assert.equal(detail.pages[0].lines[0].bill, 'bill-8');
});

test('整单冲销后新查询不再返回该行，但旧送达记录仍在', async t => {
  const { service } = await makeService(t);
  const created = await grantA(service);
  const first = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId, pageSize: '10' });
  assert.equal(first.lines.length, 2);

  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'full-line-1', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });
  await service.intakeReversal(as('clinic-a-intake'), {
    requestId: 'full-line-2', bill: 'bill-8', revision: 4, originalRevision: 1,
    reverses: [{ line: '2', amountMinor: 1200 }],
  });

  const second = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId });
  assert.equal(second.lines.length, 0);
  assert.equal(second.complete, true);
  assert.equal(service.deliveryDetail(as('doctor-1'), first.deliveryId).pages[0].lines.length, 2);
});

test('患者端可见自己向哪次就诊开放过什么范围', async t => {
  const { service } = await makeService(t);
  const created = await grantA(service);
  const read = await service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId, pageSize: '1' });
  const view = service.patientGrants(as('person-a')).grants[0];
  assert.equal(view.visit, 'visit-a');
  assert.equal(view.doctor, 'doctor-1');
  assert.equal(view.hospital, 'hospital-a');
  assert.deepEqual(view.range, ['2026-01-01', '2026-12-31']);
  assert.equal(view.disclosure.pages, 1);
  assert.equal(view.disclosure.lines, 1);
  void read;
});
