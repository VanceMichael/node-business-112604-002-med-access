import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 单进程持久状态。
 *
 * - 每次变更在草稿副本上完成，校验通过后原子改名落盘；
 * - 落盘成功才替换内存快照，失败时保留旧状态；
 * - 所有写操作串行，读请求看到的是最近一次成功落盘的完整快照。
 */
export class Store {
  constructor(statePath) {
    this.statePath = statePath;
    this.state = null;
    this.serial = Promise.resolve();
  }

  async open(createInitial) {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = createInitial();
      await this.write(this.state);
    }
    return this;
  }

  snapshot() {
    return this.state;
  }

  async write(state) {
    const temporary = this.statePath + '.tmp';
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, this.statePath);
  }

  /**
   * 在完整副本上执行读改写。mutator 抛错或落盘失败时，
   * 内存状态和磁盘状态都保持不变。
   */
  async transact(mutator) {
    const previous = this.serial;
    let release;
    this.serial = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      await this.write(draft);
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }
}
