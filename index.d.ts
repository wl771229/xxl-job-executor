export interface ExecutorConfig {
  adminBaseUrl: string
  accessToken: string
  host?: string
  port?: number
  autoRegister?: boolean
  appName?: string
  executorAddress?: string
  registerIntervalMs?: number
}

export interface NormalizedExecutorConfig {
  adminBaseUrl: string
  accessToken: string
  host: string
  port: number
  autoRegister: boolean
  appName: string
  executorAddress: string
  registerIntervalMs: number
}

export interface JobLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface JobContext {
  jobId: number
  logId: number
  logDateTime: number
  params: string
  blockStrategy: string
  timeoutSeconds: number
  broadcastIndex: number
  broadcastTotal: number
  glueType: 'BEAN'
  signal: AbortSignal
  log: JobLogger
}

export interface JobResult {
  handleCode: 200 | 500
  handleMsg: string
}

export type JobHandler = (context: JobContext) => JobResult | void | Promise<JobResult | void>

export interface LoggerLike {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
}

export interface ExecutorOptions {
  config: ExecutorConfig | NormalizedExecutorConfig
  handlers: Record<string, JobHandler>
  logger?: LoggerLike
  fetchImpl?: typeof fetch
}

export interface Executor {
  start(): Promise<{ host: string, port: number }>
  stop(): Promise<void>
}

export function createXxlJobExecutor(options: ExecutorOptions): Executor

export function parseConfig(input: ExecutorConfig): NormalizedExecutorConfig

export function loadConfig(
  env?: Record<string, string | undefined>,
  options?: { prefix?: string }
): NormalizedExecutorConfig | null

export class XxlJobConfigError extends Error {
  readonly field: string
}
