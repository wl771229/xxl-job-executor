# xxl-job-executor

面向 Node.js 的 XXL-JOB 2.4.x 执行器，支持多任务、在线日志、取消信号、执行超时和自动注册。

## 环境要求

- Node.js >= 22.12
- XXL-JOB Admin 2.4.x
- Admin 与执行器之间网络可达

## 安装

```bash
# 尚未发布到 npm，请先用下面的方式之一
npm install "git+ssh://git@github.com/<you>/xxl-job-executor.git#v0.1.0"

# 或者从本地目录安装
npm install ../xxl-job-executor
```

首次发布到 npm 后：

```bash
npm install xxl-job-executor
```

## 快速开始

```js
import { createXxlJobExecutor, loadConfig } from 'xxl-job-executor'

const config = loadConfig(process.env) // 未配置 XXL_* 时返回 null
if (!config) {
  console.log('XXL-JOB 执行器未启用')
  process.exit(0)
}

const executor = createXxlJobExecutor({
  config,
  handlers: {
    tokenRefreshHandler: async ({ jobId, params, signal, log }) => {
      log.info(`任务开始，jobId=${jobId}`)

      // 需要长时间执行时，响应取消信号
      if (signal.aborted) return { handleCode: 500, handleMsg: '任务已取消' }

      // 在这里执行你的任务；params 是 Admin 传来的原始字符串
      log.info(`参数：${params}`)
      return { handleCode: 200, handleMsg: '完成' }
    }
  }
})

const { host, port } = await executor.start()
console.log(`执行器已监听 http://${host}:${port}`)

process.on('SIGINT', async () => {
  await executor.stop()
  process.exit(0)
})
```

## 配置

`loadConfig(process.env)` 读取以下环境变量：

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `XXL_ADMIN_BASE_URL` | 是 | — | 调度中心地址，例如 `http://192.168.1.10:8080/xxl-job-admin` |
| `XXL_ACCESS_TOKEN` | 是 | — | 必须与 Admin 的 `xxl.job.accessToken` 一致；至少 8 个字符 |
| `XXL_EXECUTOR_HOST` | 否 | `127.0.0.1` | 绑定地址；仅允许回环或 RFC1918 IPv4 |
| `XXL_EXECUTOR_PORT` | 否 | `9999` | 绑定端口；`0` 表示随机端口 |
| `XXL_AUTO_REGISTER` | 否 | `false` | 设为 `true` 时向 Admin 自动注册 |
| `XXL_APP_NAME` | 自动注册时必填 | — | 执行器 AppName，每个服务应唯一 |
| `XXL_EXECUTOR_ADDRESS` | 自动注册时必填 | — | Admin 可访问的执行器地址，例如 `http://192.168.1.23:9999/` |
| `XXL_REGISTER_INTERVAL_MS` | 否 | `30000` | 自动注册心跳间隔，范围 1000–600000 |

两项必填配置必须同时存在。两项都没有配置时，`loadConfig` 返回 `null`；只配置其中一项会抛出 `XxlJobConfigError`。

如果项目不使用环境变量，可以直接调用 `parseConfig`：

```js
import { parseConfig } from 'xxl-job-executor'

const config = parseConfig({
  adminBaseUrl: 'http://192.168.1.10:8080/xxl-job-admin',
  accessToken: 'replace-me',
  host: '192.168.1.23',
  port: 9999,
  autoRegister: true,
  appName: 'demo-executor',
  executorAddress: 'http://192.168.1.23:9999/',
  registerIntervalMs: 30000
})
```

调度中心 URL、执行器绑定地址和注册地址都只允许规范的回环或 RFC1918 IPv4 地址，不接受 DNS 域名、公网 IPv4、IPv6、凭据、query 和 hash。

## 注册方式

### 手动录入

不设置 `autoRegister`，在 Admin 的「执行器管理」中手动录入执行器地址。适合地址固定、网络策略严格的场景。

### 自动注册

设置 `autoRegister: true`、`appName` 和 `executorAddress`。执行器启动后立即向 Admin 注册，并按 `registerIntervalMs` 续约；停止时发送一次注销请求。

`executorAddress` 必须是 Admin 能访问到的地址，通常填写执行器所在机器的私网 IP 和实际端口。注意事项：

- 同一个 AppName 不要同时使用手动录入和自动注册，否则 Admin 会看到重复地址。
- `executorAddress` 必须与实际绑定地址和端口一致，或通过反向代理可达。
- 自动注册时不能使用随机端口（`port: 0`）。
- 同一台机器上的多个服务请使用不同的 AppName 和端口。

## 任务处理器

处理器收到以下上下文：

| 字段 | 类型 | 说明 |
|---|---|---|
| `jobId` | `number` | Admin 的任务 ID |
| `logId` | `number` | 本次执行的日志 ID |
| `logDateTime` | `number` | Admin 传入的日志时间 |
| `params` | `string` | Admin 传入的 `executorParams`，原样传递 |
| `blockStrategy` | `string` | Admin 的阻塞策略，仅透传 |
| `timeoutSeconds` | `number` | 执行超时秒数，`0` 表示不超时 |
| `broadcastIndex` | `number` | 分片序号 |
| `broadcastTotal` | `number` | 分片总数 |
| `glueType` | `'BEAN'` | 当前只支持 BEAN |
| `signal` | `AbortSignal` | kill、超时或执行器停止时触发 |
| `log` | `JobLogger` | 写入 Admin 在线日志的 `debug/info/warn/error` |

返回值：

```ts
{ handleCode: 200 | 500, handleMsg: string }
```

- 返回其他内容（包括 `undefined`）按成功（`200`）处理，消息为空。
- 抛出或 reject 会报告 `500`；未响应取消信号时消息为 `任务执行失败`，响应取消时为 `任务已取消`。
- 超时会报告 `500`，消息为 `任务执行超时`。
- 未知任务名和非 BEAN 任务会在受理阶段直接拒绝，不产生回调。

### 日志

使用 `log.info('...')`、`log.warn('...')` 等写入本次执行的日志，Admin 的任务日志页面可以实时查看。日志保存在执行器内存中，每次执行最多保留 1000 行，执行结束后保留 10 分钟。

### 取消与超时

- Admin 点击「终止」时，执行器会 abort 对应任务的 `signal`。处理器应监听该信号并尽快退出；不监听时任务会继续执行，最终回调仍报告真实结果。
- `executorTimeout` 大于 0 时，执行器会在超时后 abort `signal` 并回调 `任务执行超时`。
- 执行器停止时也会 abort 所有在途任务的 `signal`，并等待它们结束。

## Admin 配置

1. 执行器管理 → 新增：手动录入或使用自动注册；每个服务使用唯一的 AppName。
2. 任务管理 → 新增：运行模式选 **BEAN**，JobHandler 与 `handlers` 的 key 一致，填写 Quartz cron 表达式。
3. 建议阻塞策略使用「丢弃后续调度」，失败重试次数按需设置。
4. 启动任务并手动执行一次，确认回调状态和在线日志正常。

访问令牌是 Admin 的全局配置（`xxl.job.accessToken`），所有连接同一 Admin 的执行器使用同一个值。

## API

### `createXxlJobExecutor({ config, handlers, logger?, fetchImpl? })`

返回 `{ start, stop }`。

- `start()` 解析为 `{ host, port }`。重复启动或已停止时抛错。
- `stop()` 幂等。停止自动注册、abort 在途任务、关闭端口，并等待任务回调和日志写入完成。
- `logger` 可选，只需要 `info(fields, message)` 和 `warn(fields, message)`。
- `fetchImpl` 可注入，便于测试。

### `loadConfig(env = process.env, { prefix = 'XXL_' } = {})`

返回冻结的配置对象或 `null`。配置不完整或非法时抛出 `XxlJobConfigError`。

### `parseConfig(input)`

校验并规范化配置对象，返回冻结对象。

### `XxlJobConfigError`

配置非法时抛出，`field` 属性标识出错的输入项。

## 限制

- 只支持 BEAN 任务，不支持 GLUE 脚本。
- 分片参数只透传给处理器，执行器不实现分片路由。
- 阻塞策略由 Admin 侧控制，执行器不排队；建议使用「丢弃后续调度」。
- 日志保存在内存中，执行器重启后会丢失。
- 回调只发送一次，不重试；失败由 Admin 标记并告警。
- 只支持 XXL-JOB 2.4.x，不支持 Admin 3.x。

## 排错

- `访问令牌无效`：`XXL_ACCESS_TOKEN` 与 Admin 的 `xxl.job.accessToken` 不一致。
- 日志出现 `xxl-registry-failed`：自动注册失败，检查 Admin 地址、网络和访问令牌。
- 日志出现 `xxl-callback-failed`：回调 Admin 失败，检查 `XXL_ADMIN_BASE_URL` 和 `/xxl-job-admin` 上下文路径。
- Admin 显示执行器离线：检查 `executorAddress` 是否可从 Admin 访问，端口和防火墙是否放行。
- `任务处理器不存在`：Admin 里的 JobHandler 名称与 `handlers` 的 key 不一致。
- `任务执行超时`：检查 `executorTimeout` 设置和任务耗时。
- 任务一直不结束：处理器可能忽略了 `signal`；在取消或停止时主动检查 `signal.aborted`。
- 端口被占用：同一台机器上的不同服务使用不同的 `XXL_EXECUTOR_PORT`。

## 兼容性

| 包版本 | XXL-JOB Admin | Node.js |
|---|---|---|
| 0.1.x | 2.4.x | >=22.12 |

## 许可证

MIT
