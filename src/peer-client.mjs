/**
 * 院方人员、就诊和更正接收端的薄客户端。
 *
 * 联调端按 requestId 去重，因此这里使用稳定的请求号：
 * 外部事实变化后由联调端 PUT /admin/results/请求号 更新，再由业务服务重新查询。
 */
export const staffRequestId = (hospitalId, doctorId) => `staff.${hospitalId}.${doctorId}`;
export const visitRequestId = visitId => `visit.${visitId}`;
export const correctionRequestId = notificationId => `correction.${notificationId}`;

export class PeerUnavailableError extends Error {
  constructor(message) { super(message); this.code = 'peer_unavailable'; }
}

export class PeerClient {
  constructor({ baseUrl, key = 'local-synthetic-peer', timeoutMs = 3000 } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  get configured() { return Boolean(this.baseUrl); }

  async operation(operation, body) {
    if (!this.baseUrl) throw new PeerUnavailableError('未配置院方联调接收端');
    let response;
    try {
      response = await fetch(`${this.baseUrl}/operations/${encodeURIComponent(operation)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-peer-key': this.key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PeerUnavailableError(`院方联调接收端不可用：${error.message}`);
    }
    if (!response.ok) throw new PeerUnavailableError(`院方联调接收端返回 ${response.status}`);
    const item = await response.json();
    if (!item || typeof item !== 'object' || !item.result) {
      throw new PeerUnavailableError('院方联调接收端未返回结果');
    }
    return item.result;
  }

  staff(hospitalId, doctorId) {
    return this.operation('staff', { requestId: staffRequestId(hospitalId, doctorId), hospitalId, doctorId });
  }

  visit(visitId) {
    return this.operation('visit', { requestId: visitRequestId(visitId), visitId });
  }

  /** 更正通知只携带通知编号与来源行版本，不带患者身份或药品名称。 */
  correction(notification) {
    return this.operation('correction', {
      requestId: correctionRequestId(notification.notificationId),
      notificationId: notification.notificationId,
      hospitalId: notification.hospital,
      line: notification.line,
      importedRevision: notification.importedRevision,
      currentRevision: notification.currentRevision,
      kind: notification.kind,
    });
  }
}
