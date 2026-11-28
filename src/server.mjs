import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { createService } from './service.mjs';
import { PeerClient } from './peer-client.mjs';
import { createInitialState } from './seed.mjs';
import { ServiceError } from './util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = rel => readFile(path.join(root, rel), 'utf8').then(JSON.parse);

export async function buildService({
  statePath = process.env.SERVICE_STATE || '.local/service-state.json',
  peerUrl = process.env.PEER_URL || null,
  peerKey = process.env.PEER_KEY || 'local-synthetic-peer',
  clock = () => new Date(),
  reset = false,
} = {}) {
  const [actors, catalog] = await Promise.all([readJson('data/actors.json'), readJson('data/catalog.json')]);
  const absolute = path.resolve(root, statePath);
  const store = new Store(absolute);
  if (reset) {
    await store.open(() => createInitialState(catalog));
    await store.transact(draft => {
      const fresh = createInitialState(catalog);
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, fresh);
    });
  } else {
    await store.open(() => createInitialState(catalog));
  }
  const peer = new PeerClient({ baseUrl: peerUrl, key: peerKey });
  // 未配置院方联调端时，人员与就诊事实取静态目录，仅用于本地演示。
  const catalogDoctors = new Map((catalog.actors || [])
    .filter(actor => actor.role === 'doctor')
    .map(actor => [actor.id, actor]));
  const catalogVisits = new Map((catalog.visits || []).map(visit => [visit.id, visit]));
  const directory = {
    async staff(hospitalId, doctorId) {
      if (peer.configured) return peer.staff(hospitalId, doctorId);
      const doctor = catalogDoctors.get(doctorId);
      return {
        doctorId,
        hospitalId: doctor?.hospital ?? null,
        active: Boolean(doctor) && doctor.hospital === hospitalId,
      };
    },
    async visit(visitId) {
      if (peer.configured) return peer.visit(visitId);
      const visit = catalogVisits.get(visitId);
      return {
        visitId,
        personId: visit?.person ?? null,
        doctorId: visit?.doctor ?? null,
        open: visit?.open === true,
      };
    },
  };
  const service = createService({ store, actors, directory, peer, clock });
  return { service, store, peer, actors, catalog };
}

function reply(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function tokenOf(request) {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  const local = request.headers['x-local-token'];
  return typeof local === 'string' ? local : '';
}

async function bodyOf(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) {
      throw new ServiceError(413, 'payload_too_large', '请求体不得超过 1 MiB');
    }
  }
  if (data.trim() === '') return {};
  try {
    return JSON.parse(data);
  } catch {
    throw new ServiceError(400, 'invalid_json', '请求体不是有效 JSON');
  }
}

export function createServer(service) {
  return http.createServer((request, response) => {
    let work;
    if (request.method === 'GET' && request.url === '/health') {
      reply(response, 200, { ok: true, name: '跨机构用药记录就诊授权服务' });
      return;
    }
    work = (async () => {
      const url = new URL(request.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const body = ['POST', 'PATCH', 'PUT'].includes(request.method) ? await bodyOf(request) : {};
      const actor = service.authenticate(tokenOf(request));
      const query = Object.fromEntries(url.searchParams);

      // 患者
      if (request.method === 'GET' && url.pathname === '/me/records') {
        return reply(response, 200, service.patientRecords(actor));
      }
      if (request.method === 'GET' && url.pathname === '/me/grants') {
        return reply(response, 200, service.patientGrants(actor));
      }
      if (request.method === 'POST' && url.pathname === '/grants') {
        return reply(response, 201, await service.createGrant(actor, body));
      }
      if (segments[0] === 'grants' && segments.length >= 2) {
        const grantId = segments[1];
        if (request.method === 'PATCH' && segments.length === 2) {
          return reply(response, 200, await service.reviseGrant(actor, grantId, body));
        }
        if (request.method === 'POST' && segments[2] === 'revoke' && segments.length === 3) {
          return reply(response, 200, await service.revokeGrant(actor, grantId, body));
        }
      }

      // 医生
      if (request.method === 'GET' && url.pathname === '/doctor/grants') {
        return reply(response, 200, service.doctorGrants(actor));
      }
      if (request.method === 'GET' && url.pathname === '/doctor/records') {
        return reply(response, 200, await service.doctorRead(actor, query));
      }
      if (request.method === 'GET' && url.pathname === '/doctor/deliveries') {
        return reply(response, 200, service.deliveriesForDoctor(actor));
      }
      if (request.method === 'GET' && segments[0] === 'doctor' && segments[1] === 'deliveries' && segments.length === 3) {
        return reply(response, 200, service.deliveryDetail(actor, segments[2]));
      }

      // 医院病案
      if (request.method === 'POST' && url.pathname === '/hospital/receipts') {
        return reply(response, 201, await service.hospitalReceipt(actor, body));
      }
      if (request.method === 'GET' && url.pathname === '/hospital/receipts') {
        return reply(response, 200, service.hospitalReceipts(actor));
      }
      if (request.method === 'GET' && url.pathname === '/hospital/notifications') {
        return reply(response, 200, service.notificationsFor(actor));
      }
      if (request.method === 'POST' && segments[0] === 'hospital' && segments[1] === 'notifications'
        && segments[3] === 'ack' && segments.length === 4) {
        return reply(response, 200, await service.acknowledgeNotification(actor, segments[2], body));
      }

      // 来源端
      if (request.method === 'POST' && url.pathname === '/intake/coverage') {
        return reply(response, 200, await service.intakeCoverage(actor, body));
      }
      if (request.method === 'POST' && url.pathname === '/intake/settlements') {
        return reply(response, 201, await service.intakeSettlement(actor, body));
      }
      if (request.method === 'POST' && url.pathname === '/intake/reversals') {
        return reply(response, 201, await service.intakeReversal(actor, body));
      }
      if (request.method === 'POST' && url.pathname === '/intake/bindings') {
        return reply(response, 201, await service.intakeBinding(actor, body));
      }
      if (request.method === 'GET' && url.pathname === '/source/state') {
        return reply(response, 200, service.sourceState(actor));
      }

      reply(response, 404, { error: 'not_found', message: '路径不存在' });
    })();
    work.catch(error => {
      if (response.headersSent) return;
      if (error instanceof ServiceError) {
        return reply(response, error.status, {
          error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}),
        });
      }
      reply(response, 500, { error: 'internal_error', message: '服务处理失败' });
    });
  });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const port = Number(process.env.SERVICE_PORT || 4400);
  const host = process.env.SERVICE_HOST || '127.0.0.1';
  const { service } = await buildService();
  // 重启后补投上次未成功送达的更正通知；失败不影响服务启动。
  service.flushNotifications().catch(() => {});
  const server = createServer(service);
  server.listen(port, host, () => {
    process.stdout.write(JSON.stringify({ message: '业务服务已启动', port: server.address().port }) + '\n');
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
