import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createService } from '../src/service.mjs';
import { createInitialState } from '../src/seed.mjs';

export const ACTORS = JSON.parse(await (await import('node:fs/promises'))
  .readFile(new URL('../data/actors.json', import.meta.url)));

export async function temporaryState(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'med-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state.json');
}

/**
 * 可编程的院方目录替身：测试可直接改 active / open 观察授权是否仍被承认。
 */
export function fakeDirectory(initial = {}) {
  const rawDoctors = initial.doctors || {
    'hospital-a': {
      'doctor-1': { doctorId: 'doctor-1', hospitalId: 'hospital-a', active: true },
      'doctor-2': { doctorId: 'doctor-2', hospitalId: 'hospital-a', active: true },
    },
    'hospital-b': {
      'doctor-1': { doctorId: 'doctor-1', hospitalId: 'hospital-b', active: true },
    },
  };
  const doctors = new Map(Object.entries(rawDoctors)
    .map(([hospital, entries]) => [hospital, new Map(Object.entries(entries))]));
  const visits = new Map(Object.entries(initial.visits || {
    'visit-a': { visitId: 'visit-a', personId: 'person-a', doctorId: 'doctor-1', open: true },
    'visit-b': { visitId: 'visit-b', personId: 'person-a', doctorId: 'doctor-1', open: true },
  }));
  return {
    doctors,
    visits,
    calls: { staff: 0, visit: 0 },
    async staff(hospitalId, doctorId) {
      this.calls.staff += 1;
      return doctors.get(hospitalId)?.get(doctorId)
        || { doctorId, hospitalId: null, active: false };
    },
    async visit(visitId) {
      this.calls.visit += 1;
      return visits.get(visitId) || { visitId, personId: null, doctorId: null, open: false };
    },
  };
}

export async function makeService(t, { statePath, clock, directory, peer, reset = true } = {}) {
  const file = statePath || await temporaryState(t);
  const catalog = JSON.parse(await (await import('node:fs/promises'))
    .readFile(new URL('../data/catalog.json', import.meta.url)));
  const store = new Store(file);
  await store.open(() => createInitialState(catalog));
  if (reset) {
    await store.transact(draft => {
      const fresh = createInitialState(catalog);
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, fresh);
    });
  }
  const service = createService({
    store, actors: ACTORS,
    directory: directory || fakeDirectory(),
    peer: peer || null,
    clock: clock || (() => new Date('2026-11-25T09:00:00Z')),
  });
  return { service, store, statePath: file, reopen: () => new Store(file).open(() => createInitialState(catalog)) };
}

export const as = (actorId) => {
  const actor = ACTORS.actors.find(item => item.id === actorId);
  if (!actor) throw new Error('未知合成身份：' + actorId);
  return actor;
};

export const token = actorId => as(actorId).token;
