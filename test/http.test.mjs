import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { buildService, createServer } from '../src/server.mjs';
import { staffRequestId, visitRequestId, correctionRequestId } from '../src/peer-client.mjs';

const headers = { 'content-type': 'application/json', 'x-peer-key': 'local-synthetic-peer' };
const auth = token => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

async function startProcess(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const failed = new Promise((_, reject) => child.once('exit', code => reject(new Error(`${script} 提前退出：${code}`))));
  const line = await Promise.race([once(lines, 'line').then(([value]) => value), failed]);
  return {
    port: JSON.parse(line).port,
    async stop() {
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
      lines.close();
    },
  };
}

test('HTTP：授权、分段读取、导入确认、迟到冲销更正与院方回执', { timeout: 20000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'med-http-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const peer = await startProcess('support/peer.mjs', {
    PEER_PORT: '0', PEER_STATE: path.join(temporary, 'peer.json'),
  });
  t.after(() => peer.stop());
  const peerBase = `http://127.0.0.1:${peer.port}`;

  // 先准备好院方人员与就诊事实，供业务服务查询。
  const plan = async (requestId, result) => {
    const response = await fetch(`${peerBase}/admin/plans/${encodeURIComponent(requestId)}`, {
      method: 'PUT', headers, body: JSON.stringify({ mode: 'normal', result }),
    });
    assert.equal(response.status, 200);
  };
  await plan(staffRequestId('hospital-a', 'doctor-1'), {
    doctorId: 'doctor-1', hospitalId: 'hospital-a', active: true,
  });
  await plan(visitRequestId('visit-a'), {
    visitId: 'visit-a', personId: 'person-a', doctorId: 'doctor-1', open: true,
  });

  const { service } = await buildService({
    statePath: path.join(temporary, 'service.json'),
    peerUrl: peerBase,
    clock: () => new Date('2026-11-25T09:00:00Z'),
  });
  const server = createServer(service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const patient = 'local-patient-a';
  const doctor = 'local-doctor-1';
  const hospital = 'local-hospital-a';
  const intake = 'local-source-clinic-a';

  const created = await fetch(`${base}/grants`, {
    method: 'POST', headers: auth(patient),
    body: JSON.stringify({
      requestId: 'http-grant', hospital: 'hospital-a', doctor: 'doctor-1', visit: 'visit-a',
      range: ['2026-01-01', '2026-12-31'], expiresAt: '2026-11-25T18:00:00Z',
    }),
  }).then(async response => ({ status: response.status, body: await response.json() }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const grantId = created.body.grant.grantId;

  const page1 = await fetch(`${base}/doctor/records?grantId=${grantId}&pageSize=1`, {
    headers: auth(doctor),
  }).then(response => response.json());
  assert.equal(page1.lines.length, 1);
  assert.equal(page1.complete, false);

  const receipt = await fetch(`${base}/hospital/receipts`, {
    method: 'POST', headers: auth(hospital),
    body: JSON.stringify({
      requestId: 'http-receipt-1', deliveryId: page1.deliveryId,
      lines: page1.lines.map(line => ({
        source: line.source, bill: line.bill, line: line.line, revision: line.revision,
      })),
    }),
  }).then(response => response.json());
  assert.equal(receipt.receipt.deliveryId, page1.deliveryId);

  // 迟到冲销第 1 行：业务服务应向院方联调端发送更正通知。
  const reversal = await fetch(`${base}/intake/reversals`, {
    method: 'POST', headers: auth(intake),
    body: JSON.stringify({
      requestId: 'http-rev-3', bill: 'bill-8', revision: 3, originalRevision: 1,
      reverses: [{ line: '1', amountMinor: 2100 }],
    }),
  }).then(async response => ({ status: response.status, body: await response.json() }));
  assert.equal(reversal.status, 201, JSON.stringify(reversal.body));
  assert.equal(reversal.body.notifications.length, 1);

  const notificationId = reversal.body.notifications[0];
  const sent = await fetch(`${peerBase}/requests/${encodeURIComponent(correctionRequestId(notificationId))}`, { headers })
    .then(response => ({ status: response.status, body: response.status === 200 ? null : response }));
  assert.equal(sent.status, 200);
  const recorded = await fetch(`${peerBase}/requests/${encodeURIComponent(correctionRequestId(notificationId))}`, { headers })
    .then(response => response.json());
  assert.equal(recorded.operation, 'correction');
  assert.equal(recorded.body.notificationId, notificationId);
  assert.equal(JSON.stringify(recorded.body).includes('person-a'), false);
  assert.equal(JSON.stringify(recorded.body).includes('synthetic-a'), false);

  // 医院列表与回执。
  const inbox = await fetch(`${base}/hospital/notifications`, { headers: auth(hospital) })
    .then(response => response.json());
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0].notificationId, notificationId);

  const ack = await fetch(`${base}/hospital/notifications/${notificationId}/ack`, {
    method: 'POST', headers: auth(hospital), body: JSON.stringify({ requestId: 'http-ack-1' }),
  }).then(response => response.json());
  assert.equal(ack.status, 'acknowledged');

  // 第二页受撤回/范围变化保护：这里范围未变，但第 1 行被冲销已使旧页失效。
  const second = await fetch(`${base}/doctor/records?grantId=${grantId}&cursor=${encodeURIComponent(page1.nextCursor)}`, {
    headers: auth(doctor),
  }).then(async response => ({ status: response.status, body: await response.json() }));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'visible_scope_changed');

  // 患者端看到有效结算、已冲销、待核及授权披露范围。
  const records = await fetch(`${base}/me/records`, { headers: auth(patient) }).then(response => response.json());
  assert.equal(records.valid.length, 1);
  assert.equal(records.valid[0].lines.find(line => line.line === '1').status, 'reversed');
  const grants = await fetch(`${base}/me/grants`, { headers: auth(patient) }).then(response => response.json());
  assert.equal(grants.grants[0].disclosure.lines, 1);

  // 身份与权限隔离。
  const anonymous = await fetch(`${base}/me/records`);
  assert.equal(anonymous.status, 401);
  const otherDoctor = await fetch(`${base}/doctor/records?grantId=${grantId}`, { headers: auth('local-doctor-2') });
  assert.equal(otherDoctor.status, 404);
});
