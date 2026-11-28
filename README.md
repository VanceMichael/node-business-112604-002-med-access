# 跨机构用药记录的就诊授权与更正交付

这个项目是跨机构用药记录的就诊授权与更正交付服务端。患者可以查看自己的用药记录，并在一次真实就诊中把经本人允许的既往用药开放给接诊医生；医疗机构与药店可继续投送结算增量、冲销和归属资料，医院可分页接收并确认已导入院内病历，来源端的迟到冲销与归属改正会转成面向实际接收医院的更正通知。

服务只呈现来源记录，不判断药物是否适合服用。当前可运行内容：

- 业务服务（Node.js 22.23.4，无第三方运行依赖）：患者读取与授权、医生分段取数、医院导入确认与更正回执、来源端持续投送、持久化状态；
- 合成资料核查与院方人员、就诊、更正接收端的本地联调替身；
- 跨页撤回与迟到冲销相遇的可执行检查。

字段说明见 [资料约定](docs/资料约定.md)，业务接口与操作步骤见 [业务服务使用说明](docs/业务服务使用说明.md)，院方联调端见 [联调协议](docs/联调协议.md)。

本地准备与检查：
```sh
npm ci --ignore-scripts
npm run check:data
npm run check:flow
npm test
```

启动业务服务：
```sh
npm run service
```
默认监听本机 4400 端口，状态保存在 `.local/service-state.json`。可用 `SERVICE_PORT`、`SERVICE_HOST`、`SERVICE_STATE` 覆盖；设置 `PEER_URL` 后，医生资格、就诊状态与更正通知会改为调用院方联调端，而不是取静态目录。请求需带本地合成身份令牌，见说明文档第 1 节。

启动院方联调接收端：
```sh
npm run peer
```
默认监听本机 4300 端口，状态保存在 `.local/peer-state.json`。可用 `PEER_PORT`、`PEER_HOST`、`PEER_STATE` 覆盖。该进程是外部协作方的本地替身，不是业务服务。

容器运行：
```sh
docker build -t med-access-local .
docker run --rm -p 127.0.0.1:4400:4400 -p 127.0.0.1:4300:4300 \
  --mount type=volume,source=med-access-state,target=/home/node/state med-access-local
```
容器入口同时启动业务服务（4400）与院方联调接收端（4300），业务服务默认通过 `PEER_URL=http://127.0.0.1:4300` 查询人员、就诊与投送更正通知。命名卷保存两者状态，停止和重启容器不清除它。另开终端可运行 `docker run --rm med-access-local npm run check:data` 核查资料、`npm run check:flow` 复查跨页撤回与迟到冲销、`npm test` 运行全部测试。所有人物、证件、账户和业务编号均为合成值；不需要真实系统账号。

资料核查仅确认格式和必要引用，自动化测试覆盖授权、分页失效、导入确认、更正去向与重启后的继续办理，但不能证明生产环境中的身份与权限已经成立。
