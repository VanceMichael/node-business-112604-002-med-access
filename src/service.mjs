import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ServiceError, fail, copy, digest,
  requireString, requireInteger, requireDate, requireInstant,
  requireObject, requireArray,
} from './util.mjs';
import {
  bindingKey, billKey, lineKey,
  currentBinding, bindingHistory, billGroups, groupForBill, billLines,
  coverageFor, coverageSummary, patientView, doctorVisibleLines,
  lineView, lineState,
} from './domain.mjs';

const MAX_PAGE = 100;
const DEFAULT_PAGE = 20;

const conversationKey = (scope, requestId) => `${scope}\u0000${requestId}`;
const personScope = person => `patient:${person}`;
const hospitalScope = hospital => `hospital:${hospital}`;
const sourceScope = source => `source:${source}`;

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
}
function encodeCursor(secret, data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}
function decodeCursor(secret, token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const index = token.lastIndexOf('.');
  if (index <= 0) return null;
  const payload = token.slice(0, index);
  const mac = token.slice(index + 1);
  const expected = sign(secret, payload);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

const withoutRequestId = body => {
  const { requestId, ...rest } = body;
  return rest;
};

function requestIdOf(body) {
  requireObject(body, '请求体');
  const requestId = body.requestId;
  if (typeof requestId !== 'string' || !/^[\w.-]{1,100}$/.test(requestId)) {
    fail(400, 'invalid_request_id', 'requestId 必须为 1—100 位字母、数字、下划线、点或连字符');
  }
  return requestId;
}

function ranged(value, field) {
  requireArray(value, field, 2);
  if (value.length !== 2) fail(400, 'invalid_request', `${field} 必须恰为两项日期`);
  const from = requireDate(value[0], `${field}[0]`);
  const to = requireDate(value[1], `${field}[1]`);
  if (from > to) fail(400, 'invalid_range', `${field} 起始日期不得晚于结束日期`);
  return [from, to];
}

const subsetOf = (inner, outer) => inner[0] >= outer[0] && inner[1] <= outer[1];

function summarizeSettlement(settlement) {
  return {
    source: settlement.source,
    bill: settlement.bill,
    revision: settlement.revision,
    date: settlement.date,
    localPerson: settlement.localPerson,
    previousRevision: settlement.previousRevision ?? null,
    lines: copy(settlement.lines),
    receivedAt: settlement.receivedAt,
  };
}

function summarizeReversal(reversal) {
  return {
    source: reversal.source,
    bill: reversal.bill,
    revision: reversal.revision,
    originalRevision: reversal.originalRevision,
    reverses: copy(reversal.reverses),
    receivedAt: reversal.receivedAt,
  };
}

export function createService({ store, actors, directory, peer = null, clock = () => new Date() }) {
  const actorByToken = new Map();
  for (const actor of actors.actors || actors) {
    if (actor.token) actorByToken.set(actor.token, actor);
  }
  const now = () => clock().toISOString();
  const nowMs = () => clock().getTime();
  const state = () => store.snapshot();

  function authenticate(token) {
    if (typeof token !== 'string' || token.length === 0) {
      fail(401, 'unauthenticated', '缺少本地合成身份令牌');
    }
    const actor = actorByToken.get(token);
    if (!actor) fail(401, 'unauthenticated', '本地合成身份令牌无效');
    return actor;
  }

  function requireRole(actor, role) {
    if (actor.role !== role) fail(403, 'role_not_allowed', `该操作仅限 ${role} 角色`);
    return actor;
  }

  function recordRequest(draft, scope, requestId, body, response) {
    const key = conversationKey(scope, requestId);
    const fingerprint = digest(withoutRequestId(body));
    const prior = draft.requests[key];
    if (prior) {
      if (prior.digest !== fingerprint) {
        fail(409, 'request_id_conflict', '同一请求编号已用于不同内容', { requestId });
      }
      return { duplicate: true, response: copy(prior.response) };
    }
    draft.requests[key] = { scope, requestId, digest: fingerprint, response: copy(response), at: now() };
    return { duplicate: false, response };
  }

  function replay(draft, scope, requestId, body) {
    const key = conversationKey(scope, requestId);
    const fingerprint = digest(withoutRequestId(body));
    const prior = draft.requests[key];
    if (!prior) return null;
    if (prior.digest !== fingerprint) {
      fail(409, 'request_id_conflict', '同一请求编号已用于不同内容', { requestId });
    }
    return { ...copy(prior.response), duplicate: true };
  }

  // ------------------------------------------------------------------ 授权

  const grantActive = grant => grant.status === 'active' && nowMs() <= Date.parse(grant.expiresAt);

  function grantView(draft, grant) {
    const status = grant.status === 'revoked'
      ? 'revoked'
      : nowMs() > Date.parse(grant.expiresAt) ? 'expired' : 'active';
    const deliveries = Object.values(draft.deliveries).filter(item => item.grantId === grant.grantId);
    const disclosed = new Map();
    for (const delivery of deliveries) {
      for (const line of delivery.disclosed) disclosed.set(lineKey(line.source, line.bill, line.line), line);
    }
    const receipts = Object.values(draft.receipts).filter(item => item.grantId === grant.grantId);
    const imported = new Set();
    for (const receipt of receipts) {
      for (const line of receipt.lines) imported.add(lineKey(line.source, line.bill, line.line));
    }
    return {
      grantId: grant.grantId,
      person: grant.person,
      hospital: grant.hospital,
      doctor: grant.doctor,
      visit: grant.visit,
      range: copy(grant.range),
      expiresAt: grant.expiresAt,
      status,
      revision: grant.revision,
      createdAt: grant.createdAt,
      revokedAt: grant.revokedAt || null,
      revokeReason: grant.revokeReason || null,
      history: copy(grant.history),
      disclosure: {
        deliveries: deliveries.length,
        pages: deliveries.reduce((sum, item) => sum + item.pages.length, 0),
        lines: disclosed.size,
        lineRefs: [...disclosed.values()].map(line => ({
          source: line.source, bill: line.bill, line: line.line,
          date: line.date, revision: line.revision, at: line.at,
        })),
      },
      import: { receipts: receipts.length, lines: imported.size },
    };
  }

  function ownGrant(draft, actor, grantId) {
    const grant = draft.grants[grantId];
    if (!grant || grant.person !== actor.id) fail(404, 'grant_not_found', '授权不存在');
    return grant;
  }

  /**
   * 每次取数都重新向院方人员接口与就诊接口确认，不因持有患者授权而视为持续有效。
   */
  async function liveGrant(draft, actor, grantId) {
    const grant = draft.grants[grantId];
    if (!grant) fail(404, 'grant_not_found', '授权不存在');
    if (grant.doctor !== actor.id || grant.hospital !== actor.hospital) {
      // 不向其他医生或科室助理透露该授权是否存在。
      fail(404, 'grant_not_found', '授权不存在');
    }
    if (grant.status === 'revoked') {
      fail(403, 'grant_revoked', '患者已撤回该授权', { grantId, revokedAt: grant.revokedAt });
    }
    if (nowMs() > Date.parse(grant.expiresAt)) {
      fail(403, 'grant_expired', '该授权已过期', { grantId, expiresAt: grant.expiresAt });
    }
    let staff;
    let visit;
    try {
      staff = await directory.staff(grant.hospital, grant.doctor);
      visit = await directory.visit(grant.visit);
    } catch (error) {
      fail(503, 'directory_unavailable', '无法向院方人员或就诊接口确认资格，稍后重试', { cause: error.message });
    }
    if (!staff || staff.active !== true) {
      fail(403, 'doctor_inactive', '院方人员接口显示该医生当前不在岗', { doctor: grant.doctor });
    }
    if (staff.hospitalId && staff.hospitalId !== grant.hospital) {
      fail(403, 'doctor_hospital_mismatch', '医生不属于该接诊医院', { doctor: grant.doctor });
    }
    if (!visit || visit.open !== true) {
      fail(403, 'visit_closed', '就诊接口显示该次就诊已不再开放', { visit: grant.visit });
    }
    if (visit.personId !== grant.person || visit.doctorId !== grant.doctor) {
      fail(403, 'visit_mismatch', '就诊接口显示该次就诊不属于该患者或该医生', { visit: grant.visit });
    }
    return grant;
  }

  async function assertEligible(hospital, doctor, visit, person) {
    let staff;
    let live;
    try {
      staff = await directory.staff(hospital, doctor);
      live = await directory.visit(visit);
    } catch (error) {
      fail(503, 'directory_unavailable', '无法向院方人员或就诊接口确认资格，稍后重试', { cause: error.message });
    }
    if (!staff || staff.active !== true) fail(403, 'doctor_inactive', '院方人员接口显示该医生当前不在岗', { doctor });
    if (staff.hospitalId && staff.hospitalId !== hospital) {
      fail(403, 'doctor_hospital_mismatch', '医生不属于该接诊医院', { doctor });
    }
    if (!live || live.open !== true) fail(403, 'visit_closed', '就诊接口显示该次就诊未开放，不能据此授权', { visit });
    if (live.personId !== person || live.doctorId !== doctor) {
      fail(403, 'visit_mismatch', '就诊接口显示该次就诊不属于该患者或该医生', { visit });
    }
  }

  async function createGrant(actor, body) {
    requireRole(actor, 'patient');
    const requestId = requestIdOf(body);
    const hospital = requireString(body.hospital, 'hospital');
    const doctor = requireString(body.doctor, 'doctor');
    const visit = requireString(body.visit, 'visit');
    const range = ranged(body.range, 'range');
    const expiresAt = requireInstant(body.expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= nowMs()) fail(400, 'invalid_expiry', '到期时间必须晚于当前时间');
    return store.transact(async draft => {
      const scope = personScope(actor.id);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      await assertEligible(hospital, doctor, visit, actor.id);
      const at = now();
      const grant = {
        grantId: `grant-${randomUUID()}`,
        person: actor.id, hospital, doctor, visit,
        range: copy(range), expiresAt,
        status: 'active', revision: 1, epoch: 1,
        createdAt: at, revokedAt: null, revokeReason: null,
        history: [{ revision: 1, action: 'create', range: copy(range), expiresAt, at, requestId }],
      };
      draft.grants[grant.grantId] = grant;
      const response = { grant: grantView(draft, grant) };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
  }

  function reviseGrant(actor, grantId, body) {
    requireRole(actor, 'patient');
    const requestId = requestIdOf(body);
    const hasRange = body.range !== undefined;
    const hasExpiry = body.expiresAt !== undefined;
    if (!hasRange && !hasExpiry) fail(400, 'invalid_request', '至少提供 range 或 expiresAt');
    const range = hasRange ? ranged(body.range, 'range') : null;
    const expiresAt = hasExpiry ? requireInstant(body.expiresAt, 'expiresAt') : null;
    return store.transact(draft => {
      const scope = personScope(actor.id);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const grant = ownGrant(draft, actor, grantId);
      if (grant.status === 'revoked') fail(409, 'grant_revoked', '已撤回的授权不能修改');
      if (nowMs() > Date.parse(grant.expiresAt)) fail(409, 'grant_expired', '已过期的授权不能修改');
      if (range && !subsetOf(range, grant.range)) {
        fail(409, 'grant_widening', '就诊中的授权只能缩小购药时间范围', { current: grant.range, requested: range });
      }
      if (expiresAt) {
        if (Date.parse(expiresAt) < nowMs()) fail(400, 'invalid_expiry', '到期时间必须晚于当前时间');
        if (Date.parse(expiresAt) > Date.parse(grant.expiresAt)) {
          fail(409, 'grant_widening', '就诊中的授权不能延长到期时间', { current: grant.expiresAt, requested: expiresAt });
        }
      }
      const nextRange = range ? copy(range) : copy(grant.range);
      const nextExpiry = expiresAt || grant.expiresAt;
      if (nextRange[0] === grant.range[0] && nextRange[1] === grant.range[1] && nextExpiry === grant.expiresAt) {
        const response = { grant: grantView(draft, grant), unchanged: true };
        recordRequest(draft, scope, requestId, body, response);
        return response;
      }
      grant.range = nextRange;
      grant.expiresAt = nextExpiry;
      grant.revision += 1;
      grant.epoch += 1;
      grant.history.push({
        revision: grant.revision, action: 'narrow', range: copy(nextRange),
        expiresAt: nextExpiry, at: now(), requestId,
      });
      const response = { grant: grantView(draft, grant) };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
  }

  function revokeGrant(actor, grantId, body) {
    requireRole(actor, 'patient');
    const requestId = requestIdOf(body);
    const reason = body.reason === undefined ? null : requireString(body.reason, 'reason');
    return store.transact(draft => {
      const scope = personScope(actor.id);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const grant = ownGrant(draft, actor, grantId);
      if (grant.status !== 'revoked') {
        grant.status = 'revoked';
        grant.revokedAt = now();
        grant.revokeReason = reason;
        grant.epoch += 1;
        grant.history.push({
          revision: grant.revision, action: 'revoke', range: copy(grant.range),
          expiresAt: grant.expiresAt, at: grant.revokedAt, requestId, reason,
        });
        for (const delivery of Object.values(draft.deliveries)) {
          if (delivery.grantId === grant.grantId && delivery.status === 'open') {
            delivery.status = 'interrupted';
            delivery.interruptReason = 'grant_revoked';
            delivery.endedAt = grant.revokedAt;
          }
        }
      }
      const response = { grant: grantView(draft, grant) };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
  }

  function patientGrants(actor) {
    requireRole(actor, 'patient');
    const grants = Object.values(state().grants)
      .filter(grant => grant.person === actor.id)
      .map(grant => grantView(state(), grant))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { person: actor.id, grants };
  }

  function doctorGrants(actor) {
    requireRole(actor, 'doctor');
    const grants = Object.values(state().grants)
      .filter(grant => grant.doctor === actor.id && grant.hospital === actor.hospital && grantActive(grant))
      .map(grant => ({
        grantId: grant.grantId,
        person: grant.person,
        visit: grant.visit,
        range: copy(grant.range),
        expiresAt: grant.expiresAt,
        revision: grant.revision,
      }));
    return { doctor: actor.id, hospital: actor.hospital, grants };
  }

  // ------------------------------------------------------------------ 患者读取

  function patientRecords(actor) {
    requireRole(actor, 'patient');
    const view = patientView(state(), actor.id);
    return {
      person: actor.id,
      ...view,
      coverage: coverageSummary(state(), null),
      note: '仅呈现来源记录，不判断药物是否适合服用。',
    };
  }

  // ------------------------------------------------------------------ 医生分段读取

  function scopeFingerprint(lines) {
    return digest(lines.map(line => [
      line.source, line.bill, line.line, line.date, line.drug,
      line.amountMinor, line.netAmountMinor, line.revision,
      line.bindingRevision, line.bindingPerson, line.status,
    ]));
  }

  function pageOf(draft, delivery, pageNumber) {
    const start = (pageNumber - 1) * delivery.pageSize;
    const lines = delivery.scope.slice(start, start + delivery.pageSize);
    const pageCount = Math.max(1, Math.ceil(delivery.scope.length / delivery.pageSize));
    const complete = pageNumber >= pageCount;
    const coverage = coverageSummary(draft, delivery.range[1], delivery.range[0]);
    const warnings = [];
    const behind = coverage.sources
      .filter(item => !item.through || item.through < delivery.range[1])
      .map(item => `${item.source} 的资料仅更新至 ${item.through || '未知日期'}`);
    if (behind.length > 0) {
      warnings.push(`查询区间截至 ${delivery.range[1]}：${behind.join('；')}。未覆盖日期不代表没有购药。`);
    }
    if (delivery.status === 'interrupted') {
      warnings.push('本次分段读取已被中断，已返回的页面不能拼成当前的完整清单。');
    }
    const publicLines = lines.map(line => ({
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
    }));
    const at = now();
    delivery.pages.push({ page: pageNumber, at, lines: copy(publicLines) });
    for (const line of lines) {
      delivery.disclosed.push({
        source: line.source, bill: line.bill, line: line.line,
        revision: line.revision, bindingRevision: line.bindingRevision,
        date: line.date, drug: line.drug, amountMinor: line.amountMinor,
        reversedAmountMinor: line.reversedAmountMinor, netAmountMinor: line.netAmountMinor,
        at,
      });
    }
    if (complete) {
      delivery.status = 'complete';
      delivery.endedAt = at;
    }
    const nextCursor = complete ? null : encodeCursor(draft.cursorSecret, {
      d: delivery.deliveryId, p: pageNumber + 1, g: delivery.grantId, s: delivery.scopeDigest,
    });
    return {
      deliveryId: delivery.deliveryId,
      grantId: delivery.grantId,
      person: delivery.person,
      hospital: delivery.hospital,
      doctor: delivery.doctor,
      visit: delivery.visit,
      range: copy(delivery.range),
      page: pageNumber,
      pageCount,
      pageSize: delivery.pageSize,
      totalLines: delivery.scope.length,
      complete,
      lines: publicLines,
      coverage,
      warnings,
      nextCursor,
      observedAt: at,
    };
  }

  function newDelivery(draft, grant, pageSize) {
    const visible = doctorVisibleLines(draft, grant.person, grant.range);
    const delivery = {
      deliveryId: `delivery-${randomUUID()}`,
      grantId: grant.grantId,
      grantRevision: grant.revision,
      grantEpoch: grant.epoch,
      person: grant.person,
      hospital: grant.hospital,
      doctor: grant.doctor,
      visit: grant.visit,
      range: copy(grant.range),
      pageSize,
      scope: copy(visible),
      scopeDigest: scopeFingerprint(visible),
      status: 'open',
      pages: [],
      disclosed: [],
      createdAt: now(),
      endedAt: null,
      interruptReason: null,
    };
    draft.deliveries[delivery.deliveryId] = delivery;
    return delivery;
  }

  function emptyPage(draft, delivery) {
    const at = now();
    delivery.status = 'complete';
    delivery.endedAt = at;
    const coverage = coverageSummary(draft, delivery.range[1], delivery.range[0]);
    return {
      deliveryId: delivery.deliveryId,
      grantId: delivery.grantId,
      person: delivery.person,
      hospital: delivery.hospital,
      doctor: delivery.doctor,
      visit: delivery.visit,
      range: copy(delivery.range),
      page: 1, pageCount: 1, pageSize: delivery.pageSize,
      totalLines: 0, complete: true, lines: [],
      coverage,
      warnings: coverage.complete ? [] : [coverage.note],
      nextCursor: null,
      observedAt: at,
    };
  }

  async function doctorRead(actor, query) {
    requireRole(actor, 'doctor');
    const grantId = requireString(query.grantId, 'grantId');
    const rawPageSize = query.pageSize;
    const pageSize = rawPageSize === undefined || rawPageSize === ''
      ? DEFAULT_PAGE
      : requireInteger(Number(rawPageSize), 'pageSize', 1);
    if (pageSize > MAX_PAGE) fail(400, 'invalid_request', `pageSize 不得超过 ${MAX_PAGE}`);
    const token = query.cursor;

    if (token === undefined || token === '') {
      return store.transact(async draft => {
        const grant = await liveGrant(draft, actor, grantId);
        const delivery = newDelivery(draft, grant, pageSize);
        if (delivery.scope.length === 0) return emptyPage(draft, delivery);
        return pageOf(draft, delivery, 1);
      });
    }

    const cursor = decodeCursor(state().cursorSecret, token);
    if (!cursor || typeof cursor.d !== 'string' || typeof cursor.p !== 'number' || cursor.p < 1) {
      fail(400, 'invalid_cursor', '分段游标无效');
    }
    if (cursor.g !== grantId) fail(400, 'invalid_cursor', '分段游标与授权不匹配');

    const outcome = await store.transact(async draft => {
      const delivery = draft.deliveries[cursor.d];
      if (!delivery) fail(404, 'delivery_not_found', '分段读取不存在');
      if (delivery.grantId !== grantId) fail(400, 'invalid_cursor', '分段游标与授权不匹配');
      if (delivery.hospital !== actor.hospital || delivery.doctor !== actor.id) {
        fail(404, 'delivery_not_found', '分段读取不存在');
      }
      const stop = (reason, error) => {
        if (delivery.status === 'open') {
          delivery.status = 'interrupted';
          delivery.interruptReason = reason;
          delivery.endedAt = now();
        }
        return {
          interrupt: {
            status: error.status,
            code: error.code,
            message: error.message,
            details: {
              deliveryId: delivery.deliveryId,
              interruptReason: reason,
              completedPages: delivery.pages.length,
              ...(error.details || {}),
            },
          },
        };
      };
      if (delivery.status === 'interrupted') {
        // 撤回、归属改正、冲销或授权变更都会使旧页失效，统一以可见范围变化对外表达，
        // 具体原因留在送达单上供双方追查。
        return stop(delivery.interruptReason || 'interrupted', new ServiceError(
          409, 'visible_scope_changed', '该次分段读取已被中断，先前页面不能拼成当前清单',
          { completedPages: delivery.pages.length },
        ));
      }
      if (delivery.status === 'complete') {
        return stop('complete', new ServiceError(
          409, 'delivery_complete', '该次分段读取已经完成，如需最新清单请重新开始',
          { completedPages: delivery.pages.length },
        ));
      }
      let grant;
      try {
        grant = await liveGrant(draft, actor, grantId);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        // 院方接口暂时不可用不改变授权本身，不能因此中断本次送达。
        if (error.code === 'directory_unavailable') throw error;
        return stop(error.code, error);
      }
      if (grant.epoch !== delivery.grantEpoch) {
        return stop('grant_changed', new ServiceError(
          409, 'visible_scope_changed',
          '分页期间授权范围或状态发生变化，先前页面不能与后续页面拼成当前完整清单',
          { currentGrantRevision: grant.revision },
        ));
      }
      const current = doctorVisibleLines(draft, grant.person, grant.range);
      const currentDigest = scopeFingerprint(current);
      if (currentDigest !== delivery.scopeDigest) {
        const before = new Map(delivery.scope.map(line => [lineKey(line.source, line.bill, line.line), line]));
        const after = new Map(current.map(line => [lineKey(line.source, line.bill, line.line), line]));
        const added = [...after.keys()].filter(key => !before.has(key)).length;
        const removed = [...before.keys()].filter(key => !after.has(key)).length;
        const changed = [...before.keys()].filter(key => after.has(key)
          && digest(before.get(key)) !== digest(after.get(key))).length;
        return stop('visible_scope_changed', new ServiceError(
          409, 'visible_scope_changed',
          '分页期间患者撤回、归属改正或来源结算发生变化，先前页面已失效；请重新开始读取',
          { added, removed, changed, currentGrantRevision: grant.revision },
        ));
      }
      if (cursor.s !== delivery.scopeDigest) {
        fail(400, 'invalid_cursor', '分段游标与送达内容不匹配');
      }
      if (cursor.p > Math.max(1, Math.ceil(delivery.scope.length / delivery.pageSize))) {
        fail(400, 'invalid_cursor', '分段游标页码超出范围');
      }
      if (delivery.pages.some(page => page.page === cursor.p)) {
        fail(409, 'cursor_already_used', '该分页游标已经使用过，请从最新一页继续', {
          lastPage: delivery.pages[delivery.pages.length - 1].page,
        });
      }
      if (cursor.p !== delivery.pages.length + 1) {
        fail(409, 'cursor_out_of_order', '分页游标必须按顺序使用，不能跳过尚未返回的页面', {
          nextPage: delivery.pages.length + 1,
        });
      }
      return { page: pageOf(draft, delivery, cursor.p) };
    });

    if (outcome.interrupt) {
      fail(outcome.interrupt.status, outcome.interrupt.code, outcome.interrupt.message, outcome.interrupt.details);
    }
    return outcome.page;
  }

  function deliveriesForDoctor(actor) {
    requireRole(actor, 'doctor');
    const deliveries = Object.values(state().deliveries)
      .filter(item => item.doctor === actor.id && item.hospital === actor.hospital)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(item => ({
        deliveryId: item.deliveryId,
        grantId: item.grantId,
        person: item.person,
        visit: item.visit,
        range: copy(item.range),
        status: item.status,
        interruptReason: item.interruptReason,
        createdAt: item.createdAt,
        endedAt: item.endedAt,
        pages: item.pages.map(page => ({ page: page.page, at: page.at, lineCount: page.lines.length })),
        disclosedLineCount: new Set(item.disclosed.map(line =>
          lineKey(line.source, line.bill, line.line))).size,
      }));
    return { doctor: actor.id, deliveries };
  }

  function deliveryDetail(actor, deliveryId) {
    requireRole(actor, 'doctor');
    const delivery = state().deliveries[deliveryId];
    if (!delivery || delivery.doctor !== actor.id || delivery.hospital !== actor.hospital) {
      fail(404, 'delivery_not_found', '分段读取不存在');
    }
    return {
      deliveryId: delivery.deliveryId,
      grantId: delivery.grantId,
      person: delivery.person,
      visit: delivery.visit,
      range: copy(delivery.range),
      status: delivery.status,
      interruptReason: delivery.interruptReason,
      createdAt: delivery.createdAt,
      endedAt: delivery.endedAt,
      pages: copy(delivery.pages),
      disclosed: copy(delivery.disclosed),
      note: '这里保留的是当时实际返回的版本，不是当前清单。',
    };
  }

  // ------------------------------------------------------------------ 导入确认与更正

  function normalizeReceiptLines(draft, delivery, lines) {
    const disclosed = new Map();
    for (const line of delivery.disclosed) {
      disclosed.set(lineKey(line.source, line.bill, line.line), line);
    }
    const seen = new Set();
    const normalized = [];
    for (const [index, raw] of lines.entries()) {
      requireObject(raw, `lines[${index}]`);
      const source = requireString(raw.source, `lines[${index}].source`);
      const bill = requireString(raw.bill, `lines[${index}].bill`);
      const line = requireString(raw.line, `lines[${index}].line`);
      const revision = requireInteger(raw.revision, `lines[${index}].revision`, 1);
      const key = lineKey(source, bill, line);
      if (seen.has(key)) continue;
      seen.add(key);
      const known = disclosed.get(key);
      if (!known) {
        fail(409, 'line_not_disclosed', '接收确认只能包含该送达单实际返回过的行', { source, bill, line, revision });
      }
      if (known.revision !== revision) {
        fail(409, 'line_revision_mismatch', '接收确认引用的来源版本与当时返回的版本不一致', {
          source, bill, line, disclosedRevision: known.revision, claimedRevision: revision,
        });
      }
      normalized.push({
        source, bill, line, revision,
        drug: known.drug,
        amountMinor: known.amountMinor,
        reversedAmountMinor: known.reversedAmountMinor,
        netAmountMinor: known.netAmountMinor,
      });
    }
    if (normalized.length === 0) fail(400, 'invalid_request', 'lines 至少包含一行');
    return normalized;
  }

  /**
   * 只为实际接收过该行的医院生成更正通知；通知本身不带患者身份与药品名称。
   * 迟到的冲销或归属改正同样按回执中记录的实际行来匹配，而不是按当前授权名单。
   */
  function reconcileReceipts(draft, at) {
    const created = [];
    for (const receipt of Object.values(draft.receipts)) {
      for (const item of receipt.lines) {
        const current = lineState(draft, item.source, item.bill, item.line);
        let kind = null;
        let message = null;
        if (!current) {
          // 来源更正后该行已不在当前单据版本中。
          kind = 'removed';
          message = '该行在贵院导入后，来源单据更正已不再包含此行';
        } else if (current.bindingStatus !== 'confirmed' || current.bindingPerson !== receipt.person) {
          kind = 'reattribution';
          message = '该行在贵院导入后，来源归属已更正，不再属于原患者';
        } else if (current.status === 'reversed'
          || current.reversedAmountMinor > item.reversedAmountMinor) {
          kind = 'reversal';
          message = '该行在贵院导入后，来源结算已被冲销或部分冲销';
        }
        if (!kind) continue;
        const dedupe = [
          receipt.receiptId, kind, item.source, item.bill, item.line,
          current?.revision ?? 'removed', current?.reversedAmountMinor ?? 0,
          current?.bindingStatus ?? 'absent', current?.bindingPerson ?? 'absent',
        ].join('|');
        const notificationId = `ntf-${digest(dedupe).slice(0, 24)}`;
        if (draft.notifications[notificationId]) continue;
        draft.notifications[notificationId] = {
          notificationId,
          hospital: receipt.hospital,
          kind,
          receiptId: receipt.receiptId,
          deliveryId: receipt.deliveryId,
          grantId: receipt.grantId,
          person: receipt.person,
          source: item.source,
          bill: item.bill,
          line: item.line,
          importedRevision: item.revision,
          currentRevision: current ? current.revision : null,
          importedReversedAmountMinor: item.reversedAmountMinor,
          currentReversedAmountMinor: current ? current.reversedAmountMinor : null,
          currentStatus: current ? current.status : 'removed',
          message,
          createdAt: at,
          status: 'pending',
          acknowledgedAt: null,
          peer: null,
        };
        created.push(notificationId);
      }
    }
    return created;
  }

  function hospitalReceipt(actor, body) {
    requireRole(actor, 'hospital');
    const requestId = requestIdOf(body);
    const deliveryId = requireString(body.deliveryId, 'deliveryId');
    const lines = requireArray(body.lines, 'lines', 1);
    const result = store.transact(draft => {
      const scope = hospitalScope(actor.hospital);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const delivery = draft.deliveries[deliveryId];
      if (!delivery) fail(404, 'delivery_not_found', '送达单不存在');
      if (delivery.hospital !== actor.hospital) {
        fail(403, 'hospital_mismatch', '只能为本院接收的送达单确认导入');
      }
      const normalized = normalizeReceiptLines(draft, delivery, lines);
      const existing = Object.values(draft.receipts).find(item => item.deliveryId === deliveryId);
      if (existing) {
        if (digest(existing.lines) !== digest(normalized)) {
          fail(409, 'delivery_already_received', '同一送达单已按另一组行确认过接收', { receiptId: existing.receiptId });
        }
        const response = {
          receipt: copy(existing),
          duplicate: true,
          notifications: Object.values(draft.notifications)
            .filter(item => item.receiptId === existing.receiptId)
            .map(item => item.notificationId),
        };
        recordRequest(draft, scope, requestId, body, response);
        return response;
      }
      const at = now();
      const receipt = {
        receiptId: `receipt-${randomUUID()}`,
        requestId,
        deliveryId,
        grantId: delivery.grantId,
        hospital: actor.hospital,
        person: delivery.person,
        doctor: delivery.doctor,
        visit: delivery.visit,
        receivedAt: at,
        lines: normalized,
      };
      draft.receipts[receipt.receiptId] = receipt;
      const created = reconcileReceipts(draft, at);
      const response = {
        receipt: copy(receipt),
        notifications: created,
        note: '接收确认只记录实际导入内容，不会恢复查询权限。',
      };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
    return Promise.resolve(result).then(async value => {
      await flushNotifications();
      return value;
    });
  }

  function hospitalReceipts(actor) {
    requireRole(actor, 'hospital');
    const receipts = Object.values(state().receipts)
      .filter(item => item.hospital === actor.hospital)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map(item => copy(item));
    return { hospital: actor.hospital, receipts };
  }

  function notificationsFor(actor) {
    requireRole(actor, 'hospital');
    const notifications = Object.values(state().notifications)
      .filter(item => item.hospital === actor.hospital)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(notification => ({
        notificationId: notification.notificationId,
        kind: notification.kind,
        status: notification.status,
        createdAt: notification.createdAt,
        acknowledgedAt: notification.acknowledgedAt,
        source: notification.source,
        bill: notification.bill,
        line: notification.line,
        importedRevision: notification.importedRevision,
        currentRevision: notification.currentRevision,
        importedReversedAmountMinor: notification.importedReversedAmountMinor,
        currentReversedAmountMinor: notification.currentReversedAmountMinor,
        currentStatus: notification.currentStatus,
        message: notification.message,
        peerDelivery: notification.peerNotifiedAt
          ? { deliveredAt: notification.peerNotifiedAt }
          : { pending: true, lastError: notification.peerError || null },
      }));
    return { hospital: actor.hospital, notifications };
  }

  async function acknowledgeNotification(actor, notificationId, body) {
    requireRole(actor, 'hospital');
    const requestId = requestIdOf(body);
    const existing = state().notifications[notificationId];
    if (!existing || existing.hospital !== actor.hospital) {
      fail(404, 'notification_not_found', '更正通知不存在');
    }
    // 回执前再尝试一次投送，使院方联调端的确认与业务状态一致。
    await flushNotifications();
    return store.transact(draft => {
      const scope = hospitalScope(actor.hospital);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const notification = draft.notifications[notificationId];
      if (!notification || notification.hospital !== actor.hospital) {
        fail(404, 'notification_not_found', '更正通知不存在');
      }
      if (notification.status !== 'acknowledged') {
        notification.status = 'acknowledged';
        notification.acknowledgedAt = now();
        notification.acknowledgedBy = actor.id;
        notification.acknowledgementRequestId = requestId;
      }
      const response = {
        notificationId,
        status: 'acknowledged',
        acknowledgedAt: notification.acknowledgedAt,
        peerDelivery: notification.peerNotifiedAt
          ? { deliveredAt: notification.peerNotifiedAt }
          : { pending: true, lastError: notification.peerError || null },
      };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
  }

  async function flushNotifications() {
    if (!peer || !peer.configured) return;
    // 未成功送达的通知会在下一次投送或回执时再次尝试；成功送达的不再重发。
    const pending = Object.values(state().notifications)
      .filter(item => item.status === 'pending' && !item.peerNotifiedAt);
    for (const notification of pending) {
      let outcome;
      try {
        outcome = { result: await peer.correction(notification), at: now() };
      } catch (error) {
        outcome = { error: error.message, at: now() };
      }
      await store.transact(draft => {
        const target = draft.notifications[notification.notificationId];
        if (!target || target.peerNotifiedAt) return;
        target.peer = outcome;
        if (outcome.error) {
          target.peerError = outcome.error;
        } else {
          target.peerNotifiedAt = outcome.at;
          target.peerError = null;
        }
      });
    }
  }

  // ------------------------------------------------------------------ 来源投送

  async function intakeCoverage(actor, body) {
    requireRole(actor, 'source');
    const requestId = requestIdOf(body);
    const through = requireDate(body.through, 'through');
    return store.transact(draft => {
      const scope = sourceScope(actor.source);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const current = draft.coverage[actor.source] || { source: actor.source, through: null };
      if (current.through && through < current.through) {
        fail(409, 'coverage_regression', '资料覆盖日期不能回退', { current: current.through, received: through });
      }
      const updatedAt = now();
      draft.coverage[actor.source] = { source: actor.source, through, updatedAt, requestId };
      const response = { source: actor.source, through, updatedAt };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
  }

  async function intakeSettlement(actor, body) {
    requireRole(actor, 'source');
    const requestId = requestIdOf(body);
    const source = actor.source;
    if (body.source !== undefined && body.source !== source) {
      fail(403, 'source_mismatch', '来源端只能投送本机构的结算');
    }
    const bill = requireString(body.bill, 'bill');
    const revision = requireInteger(body.revision, 'revision', 1);
    const date = requireDate(body.date, 'date');
    const localPerson = requireString(body.localPerson, 'localPerson');
    requireArray(body.lines, 'lines', 1);
    const lines = body.lines.map((raw, index) => {
      requireObject(raw, `lines[${index}]`);
      return {
        line: requireString(raw.line, `lines[${index}].line`),
        drug: requireString(raw.drug, `lines[${index}].drug`),
        amountMinor: requireInteger(raw.amountMinor, `lines[${index}].amountMinor`, 0),
      };
    });
    if (new Set(lines.map(item => item.line)).size !== lines.length) {
      fail(400, 'invalid_request', '同一结算单内药品行号不可重复');
    }
    if (revision > 1 && body.previousRevision === undefined) {
      fail(400, 'invalid_revision', '结算更正必须引用原单及来源版本 previousRevision');
    }
    const value = await store.transact(draft => {
      const scope = sourceScope(source);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const key = `${billKey(source, bill)}\u0000${revision}`;
      const business = { source, bill, revision, date, localPerson, lines };
      const fingerprint = digest(business);
      const existing = draft.settlements[key];
      if (existing) {
        if (existing.digest !== fingerprint) {
          fail(409, 'revision_conflict', '同一来源单据版本已存在且内容不同', { source, bill, revision });
        }
        const response = { settlement: summarizeSettlement(existing), duplicate: true, counted: true };
        recordRequest(draft, scope, requestId, body, response);
        return response;
      }
      const group = groupForBill(draft, source, bill);
      const highest = group
        ? Math.max(...group.settlements.map(item => item.revision), ...group.reversals.map(item => item.revision))
        : 0;
      if (revision !== highest + 1) {
        fail(409, 'stale_revision', '结算版本必须紧接当前来源版本递增', {
          currentRevision: highest, receivedRevision: revision,
        });
      }
      let previousRevision = null;
      if (revision > 1) {
        previousRevision = requireInteger(body.previousRevision, 'previousRevision', 1);
        const previous = draft.settlements[`${billKey(source, bill)}\u0000${previousRevision}`];
        if (!previous) fail(409, 'original_missing', '引用的原单版本不存在', { previousRevision });
      }
      const settlement = {
        ...business, lines: copy(lines), previousRevision, digest: fingerprint,
        receivedAt: now(), requestId,
      };
      draft.settlements[key] = settlement;
      const notifications = reconcileReceipts(draft, settlement.receivedAt);
      const response = { settlement: summarizeSettlement(settlement), duplicate: false, notifications };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
    await flushNotifications();
    return value;
  }

  async function intakeReversal(actor, body) {
    requireRole(actor, 'source');
    const requestId = requestIdOf(body);
    const source = actor.source;
    if (body.source !== undefined && body.source !== source) {
      fail(403, 'source_mismatch', '来源端只能投送本机构的冲销');
    }
    const bill = requireString(body.bill, 'bill');
    const revision = requireInteger(body.revision, 'revision', 1);
    const originalRevision = requireInteger(body.originalRevision, 'originalRevision', 1);
    requireArray(body.reverses, 'reverses', 1);
    const reverses = body.reverses.map((raw, index) => {
      requireObject(raw, `reverses[${index}]`);
      return {
        line: requireString(raw.line, `reverses[${index}].line`),
        amountMinor: requireInteger(raw.amountMinor, `reverses[${index}].amountMinor`, 1),
      };
    });
    if (new Set(reverses.map(item => item.line)).size !== reverses.length) {
      fail(400, 'invalid_request', '同一次冲销内药品行号不可重复');
    }
    const value = await store.transact(draft => {
      const scope = sourceScope(source);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const group = groupForBill(draft, source, bill);
      if (!group) fail(404, 'bill_not_found', '原结算单不存在', { source, bill });
      const original = draft.settlements[`${billKey(source, bill)}\u0000${originalRevision}`];
      if (!original) fail(409, 'original_missing', '冲销引用的原单版本不存在', { originalRevision });
      const key = `${billKey(source, bill)}\u0000${revision}`;
      const business = { source, bill, revision, originalRevision, reverses };
      const fingerprint = digest(business);
      const existing = draft.reversals[key];
      if (existing) {
        if (existing.digest !== fingerprint) {
          fail(409, 'revision_conflict', '同一冲销版本已存在且内容不同', { source, bill, revision });
        }
        const response = { reversal: summarizeReversal(existing), duplicate: true };
        recordRequest(draft, scope, requestId, body, response);
        return response;
      }
      const highest = Math.max(
        ...group.settlements.map(item => item.revision),
        ...group.reversals.map(item => item.revision),
      );
      if (revision !== highest + 1) {
        fail(409, 'stale_revision', '冲销版本必须紧接当前来源版本递增', {
          currentRevision: highest, receivedRevision: revision,
        });
      }
      // 行号必须同时存在于被引用的原单与当前有效单据版本，金额按当前版本核对。
      const originalLines = new Map(original.lines.map(item => [item.line, item]));
      const currentLines = new Map(group.base.lines.map(item => [item.line, item]));
      const alreadyReversed = new Map();
      for (const item of group.reversals) {
        for (const entry of item.reverses) {
          alreadyReversed.set(entry.line, (alreadyReversed.get(entry.line) || 0) + entry.amountMinor);
        }
      }
      for (const item of reverses) {
        if (!originalLines.has(item.line)) {
          fail(409, 'line_missing', '冲销引用的药品行不在原单中', { line: item.line, originalRevision });
        }
        const line = currentLines.get(item.line);
        if (!line) fail(409, 'line_missing', '冲销引用的药品行不在当前单据版本中', { line: item.line });
        const already = alreadyReversed.get(item.line) || 0;
        if (already + item.amountMinor > line.amountMinor) {
          fail(409, 'amount_exceeds_line', '累计冲销金额不得超过该行原金额', {
            line: item.line,
            requestedMinor: item.amountMinor,
            alreadyReversedMinor: already,
            lineAmountMinor: line.amountMinor,
          });
        }
      }
      const reversal = {
        ...business, reverses: copy(reverses), digest: fingerprint,
        receivedAt: now(), requestId,
      };
      draft.reversals[key] = reversal;
      const notifications = reconcileReceipts(draft, reversal.receivedAt);
      const response = { reversal: summarizeReversal(reversal), duplicate: false, notifications };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
    await flushNotifications();
    return value;
  }

  async function intakeBinding(actor, body) {
    requireRole(actor, 'source');
    const requestId = requestIdOf(body);
    const source = actor.source;
    if (body.source !== undefined && body.source !== source) {
      fail(403, 'source_mismatch', '来源端只能投送本机构的归属');
    }
    const localPerson = requireString(body.localPerson, 'localPerson');
    const person = body.person === undefined || body.person === null
      ? null
      : requireString(body.person, 'person');
    const confirmed = body.confirmed === undefined ? false : body.confirmed;
    if (typeof confirmed !== 'boolean') fail(400, 'invalid_request', 'confirmed 必须为布尔值');
    if (confirmed && !person) fail(400, 'invalid_request', '确认归属必须提供 person');
    const value = await store.transact(draft => {
      const scope = sourceScope(source);
      const prior = replay(draft, scope, requestId, body);
      if (prior) return prior;
      const key = bindingKey(source, localPerson);
      const record = draft.bindings[key] || { source, localPerson, currentRevision: 0, revisions: {} };
      const revision = body.revision === undefined
        ? record.currentRevision + 1
        : requireInteger(body.revision, 'revision', 1);
      const business = { source, localPerson, revision, person, confirmed };
      const fingerprint = digest(business);
      const existing = record.revisions[revision];
      if (existing) {
        if (existing.digest !== fingerprint) {
          fail(409, 'revision_conflict', '同一归属版本已存在且内容不同', { source, localPerson, revision });
        }
        draft.bindings[key] = record;
        const response = { binding: bindingView(record, revision), duplicate: true };
        recordRequest(draft, scope, requestId, body, response);
        return response;
      }
      if (revision !== record.currentRevision + 1) {
        fail(409, 'stale_revision', '归属版本必须紧接当前版本递增', {
          currentRevision: record.currentRevision, receivedRevision: revision,
        });
      }
      record.revisions[revision] = { revision, person, confirmed, at: now(), requestId, digest: fingerprint };
      record.currentRevision = revision;
      draft.bindings[key] = record;
      const notifications = reconcileReceipts(draft, now());
      const response = {
        binding: bindingView(record, revision),
        pending: confirmed ? [] : [{
          source, localPerson, revision,
          note: '归属尚未确认，资料停在待核区；不会按姓名合并，也不会提供给接诊医生。',
        }],
        notifications,
      };
      recordRequest(draft, scope, requestId, body, response);
      return response;
    });
    await flushNotifications();
    return value;
  }

  function bindingView(record, revision) {
    const entry = record.revisions[revision];
    return {
      source: record.source,
      localPerson: record.localPerson,
      revision,
      person: entry.person,
      confirmed: entry.confirmed,
      status: entry.confirmed ? 'confirmed' : 'pending',
      at: entry.at,
    };
  }

  function sourceState(actor) {
    requireRole(actor, 'source');
    const s = state();
    const pending = [];
    for (const group of billGroups(s).values()) {
      if (group.source !== actor.source) continue;
      const binding = currentBinding(s, group.source, group.base.localPerson);
      if (binding.confirmed) continue;
      pending.push({
        source: group.source,
        bill: group.bill,
        date: group.base.date,
        localPerson: group.base.localPerson,
        claimedPerson: binding.person,
        bindingRevision: binding.revision,
        status: 'pending_review',
        note: '归属尚未确认，资料停在待核区；确认前不向患者或医生提供明细。',
      });
    }
    return {
      source: actor.source,
      coverage: coverageFor(s, actor.source),
      settlements: Object.values(s.settlements).filter(item => item.source === actor.source).map(summarizeSettlement),
      reversals: Object.values(s.reversals).filter(item => item.source === actor.source).map(summarizeReversal),
      bindings: Object.values(s.bindings)
        .filter(item => item.source === actor.source)
        .map(item => bindingView(item, item.currentRevision)),
      pending,
    };
  }

  return {
    authenticate,
    createGrant,
    reviseGrant,
    revokeGrant,
    patientGrants,
    doctorGrants,
    patientRecords,
    doctorRead,
    deliveriesForDoctor,
    deliveryDetail,
    hospitalReceipt,
    hospitalReceipts,
    notificationsFor,
    acknowledgeNotification,
    intakeCoverage,
    intakeSettlement,
    intakeReversal,
    intakeBinding,
    sourceState,
    flushNotifications,
    bindingHistory: (source, localPerson) => bindingHistory(state(), source, localPerson),
    currentBinding: (source, localPerson) => currentBinding(state(), source, localPerson),
    groups: () => billGroups(state()),
    linesOf: (source, bill) => {
      const group = groupForBill(state(), source, bill);
      return group ? billLines(group).map(lineView) : null;
    },
  };
}
