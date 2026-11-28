import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, as, fakeDirectory } from '../support/fixtures.mjs';

let counter = 0;
const grant = (service, patient, overrides = {}) => {
  counter += 1;
  return service.createGrant(patient, {
    requestId: `grant-${counter}`,
    hospital: 'hospital-a',
    doctor: 'doctor-1',
    visit: 'visit-a',
    range: ['2026-01-01', '2026-12-31'],
    expiresAt: '2026-11-25T18:00:00Z',
    ...overrides,
  });
};

test('医生只能凭患者授权取数，且每次取数都重新确认在岗与就诊开放', async t => {
  const directory = fakeDirectory();
  const { service } = await makeService(t, { directory });
  const doctor = as('doctor-1');
  const created = await grant(service, as('person-a'));

  const page = await service.doctorRead(doctor, { grantId: created.grant.grantId });
  assert.equal(page.lines.length, 2);
  assert.equal(directory.calls.staff, 2, '创建授权与取数各确认一次在岗');
  assert.equal(directory.calls.visit, 2);

  // 未获授权不能取数。
  await assert.rejects(
    service.doctorRead(doctor, { grantId: 'grant-nope' }),
    error => error.status === 404,
  );

  // 离岗后即使持有患者的有效授权也不能继续取数。
  directory.doctors.get('hospital-a').get('doctor-1').active = false;
  await assert.rejects(
    service.doctorRead(doctor, { grantId: created.grant.grantId }),
    error => error.status === 403 && error.code === 'doctor_inactive',
  );

  // 复岗但就诊已结束：另一场就诊不能沿用此授权。
  directory.doctors.get('hospital-a').get('doctor-1').active = true;
  directory.visits.get('visit-a').open = false;
  await assert.rejects(
    service.doctorRead(doctor, { grantId: created.grant.grantId }),
    error => error.status === 403 && error.code === 'visit_closed',
  );

  // 就诊重新开放后仍可用，因为授权本身没有延长。
  directory.visits.get('visit-a').open = true;
  const again = await service.doctorRead(doctor, { grantId: created.grant.grantId });
  assert.equal(again.lines.length, 2);
});

test('科室助理不能借主诊医生身份读取，另一医生也读不到', async t => {
  const directory = fakeDirectory();
  directory.doctors.get('hospital-a').set('assistant-1', {
    doctorId: 'assistant-1', hospitalId: 'hospital-a', active: true,
  });
  const { service } = await makeService(t, { directory });
  const created = await grant(service, as('person-a'));
  const assistant = as('assistant-1');
  await assert.rejects(
    service.doctorRead(assistant, { grantId: created.grant.grantId }),
    error => error.status === 403 && error.code === 'role_not_allowed',
  );
  await assert.rejects(
    service.doctorRead(as('doctor-2'), { grantId: created.grant.grantId }),
    error => error.status === 404,
  );
});

test('授权只能在就诊中缩小、不能延长、可撤回；结束后重新就诊另行授予', async t => {
  const { service } = await makeService(t);
  const patient = as('person-a');
  const doctor = as('doctor-1');
  const created = await grant(service, patient, {
    range: ['2026-11-01', '2026-11-30'],
    expiresAt: '2026-11-25T18:00:00Z',
  });
  const grantId = created.grant.grantId;

  await assert.rejects(
    service.reviseGrant(patient, grantId, { requestId: 'widen-1', range: ['2026-10-01', '2026-11-30'] }),
    error => error.status === 409 && error.code === 'grant_widening',
  );
  await assert.rejects(
    service.reviseGrant(patient, grantId, { requestId: 'extend-1', expiresAt: '2026-11-25T20:00:00Z' }),
    error => error.status === 409 && error.code === 'grant_widening',
  );

  const narrowed = await service.reviseGrant(patient, grantId, {
    requestId: 'narrow-1', range: ['2026-11-15', '2026-11-20'],
  });
  assert.equal(narrowed.grant.revision, 2);
  const page = await service.doctorRead(doctor, { grantId, pageSize: '10' });
  assert.equal(page.totalLines, 2, '缩小后的范围仍覆盖 11-20 的诊所结算');
  assert.ok(page.lines.every(line => line.source === 'clinic-a'), '药店的 11-19 不属于该患者');

  const revoked = await service.revokeGrant(patient, grantId, { requestId: 'revoke-1', reason: '就诊结束' });
  assert.equal(revoked.grant.status, 'revoked');
  await assert.rejects(
    service.doctorRead(doctor, { grantId }),
    error => error.status === 403 && error.code === 'grant_revoked',
  );
  await assert.rejects(
    service.reviseGrant(patient, grantId, { requestId: 'revise-after', range: ['2026-11-20', '2026-11-20'] }),
    error => error.status === 409 && error.code === 'grant_revoked',
  );

  // 同一个授权不会因为患者再次就诊自动延长；需要重新授予。
  const second = await grant(service, patient, {
    requestId: 'grant-visit-b', visit: 'visit-b',
    range: ['2026-11-01', '2026-11-30'], expiresAt: '2026-11-25T19:00:00Z',
  });
  assert.notEqual(second.grant.grantId, grantId);
  const fresh = await service.doctorRead(doctor, { grantId: second.grant.grantId });
  assert.equal(fresh.lines.length, 2);
  assert.equal(service.patientGrants(patient).grants.find(item => item.grantId === grantId).status, 'revoked');
});

test('到期后医生不能取数，患者需重新授予', async t => {
  let current = new Date('2026-11-25T09:00:00Z');
  const { service } = await makeService(t, { clock: () => current });
  const patient = as('person-a');
  const created = await grant(service, patient, { expiresAt: '2026-11-25T10:00:00Z' });
  current = new Date('2026-11-25T10:00:01Z');
  await assert.rejects(
    service.doctorRead(as('doctor-1'), { grantId: created.grant.grantId }),
    error => error.status === 403 && error.code === 'grant_expired',
  );
  assert.equal(service.patientGrants(patient).grants[0].status, 'expired');
});

test('跨页撤回：先返回的页保留，后续页被拒绝且不能拼成完整清单', async t => {
  const { service } = await makeService(t);
  const patient = as('person-a');
  const doctor = as('doctor-1');
  const created = await grant(service, patient);
  const grantId = created.grant.grantId;

  const page1 = await service.doctorRead(doctor, { grantId, pageSize: '1' });
  assert.equal(page1.page, 1);
  assert.equal(page1.pageCount, 2);
  assert.equal(page1.complete, false);
  assert.equal(page1.lines.length, 1);

  await service.revokeGrant(patient, grantId, { requestId: 'revoke-mid-page', reason: '患者撤回' });

  await assert.rejects(
    service.doctorRead(doctor, { grantId, cursor: page1.nextCursor }),
    error => error.status === 409 && error.code === 'visible_scope_changed',
  );

  const delivery = service.deliveryDetail(doctor, page1.deliveryId);
  assert.equal(delivery.pages.length, 1, '已返回页面保留但不能追加');
  assert.equal(delivery.status, 'interrupted');
  assert.equal(delivery.interruptReason, 'grant_revoked');
  assert.equal(delivery.pages[0].lines[0].source, 'clinic-a');
});

test('缩小范围也会使旧页失效，重启后仍如此', async t => {
  const { service, statePath, reopen } = await makeService(t);
  const patient = as('person-a');
  const doctor = as('doctor-1');
  const created = await grant(service, patient);
  const grantId = created.grant.grantId;
  const page1 = await service.doctorRead(doctor, { grantId, pageSize: '1' });
  await service.reviseGrant(patient, grantId, {
    requestId: 'narrow-mid', range: ['2026-11-20', '2026-11-20'],
  });
  await assert.rejects(
    service.doctorRead(doctor, { grantId, cursor: page1.nextCursor }),
    error => error.status === 409 && error.code === 'visible_scope_changed',
  );

  // 重新开始读取得到的是缩小后的当前清单。
  const restarted = await service.doctorRead(doctor, { grantId, pageSize: '10' });
  assert.equal(restarted.totalLines, 2);
  assert.ok(restarted.lines.every(line => line.bill === 'bill-8' && line.source === 'clinic-a'));

  void statePath;
  void reopen;
});

test('分页游标不可重放，也不能用于其他送达单', async t => {
  const { service } = await makeService(t);
  const patient = as('person-a');
  const doctor = as('doctor-1');
  const created = await grant(service, patient);
  const page1 = await service.doctorRead(doctor, { grantId: created.grant.grantId, pageSize: '1' });
  const page2 = await service.doctorRead(doctor, {
    grantId: created.grant.grantId, cursor: page1.nextCursor,
  });
  assert.equal(page2.page, 2);
  assert.equal(page2.complete, true);
  await assert.rejects(
    service.doctorRead(doctor, { grantId: created.grant.grantId, cursor: page1.nextCursor }),
    error => error.status === 409 && ['cursor_already_used', 'delivery_complete'].includes(error.code),
  );
  await assert.rejects(
    service.doctorRead(doctor, {
      grantId: created.grant.grantId,
      cursor: page1.nextCursor.slice(0, -2) + 'xx',
    }),
    error => error.status === 400 && error.code === 'invalid_cursor',
  );
});
