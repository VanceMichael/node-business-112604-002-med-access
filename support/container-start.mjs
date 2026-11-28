import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * 容器入口：同时启动院方联调接收端与业务服务。
 *
 * 两个进程的状态文件都位于命名卷 /home/node/state 下，
 * 业务服务通过 127.0.0.1 访问联调端，重启后仍在原状态上继续。
 */
const children = [
  { name: 'peer', argv: ['support/peer.mjs'], env: { PEER_PORT: process.env.PEER_PORT || '4300' } },
  { name: 'service', argv: ['src/server.mjs'], env: { SERVICE_PORT: process.env.SERVICE_PORT || '4400' } },
].map(spec => ({
  name: spec.name,
  env: spec.env,
  child: spawn(process.execPath, spec.argv, { stdio: 'inherit', env: { ...process.env, ...spec.env } }),
}));

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const item of children) item.child.kill('SIGTERM');
  Promise.all(children.map(item => new Promise(resolve => {
    if (item.child.exitCode !== null) resolve();
    else item.child.once('exit', resolve);
  }))).then(() => process.exit(code));
}
for (const item of children) {
  item.child.once('exit', code => {
    process.stderr.write(`${item.name} 已退出：${code}\n`);
    if (!stopping) stop(code ?? 0);
  });
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
