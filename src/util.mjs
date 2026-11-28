import { createHash } from 'node:crypto';

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const copy = value => structuredClone(value);
export const isDate = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
export const isInstant = value =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /T|\d{2}:\d{2}/.test(value);

export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const fail = (status, code, message, details) => { throw new ServiceError(status, code, message, details); };

export function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(400, 'invalid_request', `${field} 必须为非空字符串`);
  return value;
}
export function requireInteger(value, field, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(400, 'invalid_request', `${field} 必须为不小于 ${minimum} 的整数`);
  return value;
}
export function requireDate(value, field) {
  if (!isDate(value)) fail(400, 'invalid_request', `${field} 必须为 YYYY-MM-DD 日期`);
  return value;
}
export function requireInstant(value, field) {
  if (!isInstant(value) || Number.isNaN(Date.parse(value))) fail(400, 'invalid_request', `${field} 必须为 ISO 时间`);
  return value;
}
export function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', `${field} 必须为对象`);
  return value;
}
export function requireArray(value, field, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) fail(400, 'invalid_request', `${field} 必须为至少 ${minimum} 项的数组`);
  return value;
}
