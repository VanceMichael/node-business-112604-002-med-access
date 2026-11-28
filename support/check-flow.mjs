import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildService } from '../src/server.mjs';

/**
 * 跨页撤回与迟到冲销相遇的可执行检查。
 *
 * 场景：
 *   1. 患者向就诊 visit-a 的 doctor-1 授权；
 *   2. 医生按每页一行读取，第一页返回 clinic-a 的第 1 行；
 *   3. 医院确认已导入该行；
 *   4. 患者撤回授权，同时来源端迟到冲销第 1 行；
 *   5. 检查第二页被拒绝、第一页保留、更正只发实际接收医院。
 */
const temporary = await mkdtemp(path.join(os.tmpdir(), 'med-flow-'));
try {
  const { service } = await buildService({
    statePath: path.join(temporary, 'service.json'),
    clock: () => new Date('2026-11-25T09:00:00Z'),
  });
  const patient = service.authenticate('local-patient-a');
  const doctor = service.authenticate('local-doctor-1');
  const hospital = service.authenticate('local-hospital-a');
  const otherHospital = service.authenticate('local-hospital-b');
  const clinic = service.authenticate('local-source-clinic-a');

  const created = await service.createGrant(patient, {
    requestId: 'flow-grant', hospital: 'hospital-a', doctor: 'doctor-1', visit: 'visit-a',
    range: ['2026-01-01', '2026-12-31'], expiresAt: '2026-11-25T18:00:00Z',
  });
  const grantId = created.grant.grantId;

  const page1 = await service.doctorRead(doctor, { grantId, pageSize: '1' });
  assert.equal(page1.page, 1);
  assert.equal(page1.complete, false);
  assert.equal(page1.lines.length, 1);
  assert.equal(page1.lines[0].source, 'clinic-a');
  assert.equal(page1.lines[0].line, '1');
  assert.equal(page1.coverage.sources.find(item => item.source === 'clinic-a').through, '2026-11-24');

  await service.hospitalReceipt(hospital, {
    requestId: 'flow-receipt', deliveryId: page1.deliveryId,
    lines: page1.lines.map(line => ({
      source: line.source, bill: line.bill, line: line.line, revision: line.revision,
    })),
  });

  await service.revokeGrant(patient, grantId, { requestId: 'flow-revoke', reason: '就诊结束' });
  await service.intakeReversal(clinic, {
    requestId: 'flow-reversal', bill: 'bill-8', revision: 3, originalRevision: 1,
    reverses: [{ line: '1', amountMinor: 2100 }],
  });

  let interrupted = null;
  try {
    await service.doctorRead(doctor, { grantId, cursor: page1.nextCursor });
  } catch (error) {
    interrupted = error;
  }
  assert.ok(interrupted, '第二页必须被拒绝');
  assert.equal(interrupted.status, 409);
  assert.equal(interrupted.code, 'visible_scope_changed');
  assert.equal(interrupted.details.completedPages, 1);

  const delivery = service.deliveryDetail(doctor, page1.deliveryId);
  assert.equal(delivery.status, 'interrupted');
  assert.equal(delivery.interruptReason, 'grant_revoked');
  assert.deepEqual(delivery.pages.map(page => page.lines.map(line => line.line)), [['1']]);
  assert.equal(delivery.pages[0].lines[0].source, 'clinic-a', '已返回页面不能被改写');

  const inboxA = service.notificationsFor(hospital).notifications;
  assert.equal(inboxA.length, 1);
  assert.equal(inboxA[0].kind, 'reversal');
  assert.equal(inboxA[0].line, '1');
  assert.equal(inboxA[0].importedRevision, 1);
  assert.equal(inboxA[0].currentRevision, 3);
  assert.equal(inboxA[0].currentStatus, 'reversed');
  assert.equal(JSON.stringify(inboxA[0]).includes('person-a'), false, '更正通知不得携带患者身份');
  assert.equal(JSON.stringify(inboxA[0]).includes('synthetic-a'), false, '更正通知不得携带药品名称');
  assert.equal(service.notificationsFor(otherHospital).notifications.length, 0, '未接收原记录的医院收不到');

  const ack = await service.acknowledgeNotification(hospital, inboxA[0].notificationId, {
    requestId: 'flow-ack',
  });
  assert.equal(ack.status, 'acknowledged');

  const patientView = service.patientRecords(patient);
  assert.equal(patientView.valid.length, 1, '第 2 行仍有净额，整单仍在有效区');
  assert.equal(patientView.valid[0].lines.find(line => line.line === '1').status, 'reversed');

  process.stdout.write(JSON.stringify({
    message: '跨页撤回与迟到冲销检查通过',
    visibleAfterRevocation: {
      deliveryStatus: delivery.status,
      pages: delivery.pages.map(page => page.lines.map(line => ({
        source: line.source, bill: line.bill, line: line.line, revision: line.revision,
      }))),
      secondPage: interrupted.code,
    },
    corrections: inboxA.map(item => ({
      notificationId: item.notificationId,
      hospital: 'hospital-a',
      kind: item.kind,
      line: item.line,
      importedRevision: item.importedRevision,
      currentRevision: item.currentRevision,
      status: item.status,
    })),
  }, null, 2) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
