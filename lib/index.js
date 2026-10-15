/**
 * dsh-run-guard: agent run-rhythm guard for DeepSeek Harness.
 *
 * Merged from dsh-reasoning-guard + todo-continue:
 *  - guard: intercepts `llm/stream`, detects reasoning dead loops
 *    (sliding-window repeat ratio + hard per-call caps) and terminates the
 *    stream with a `REASONING_GUARD` error finish.
 *  - continue: after a turn ends, resumes execution — with pending todos it
 *    injects the todo status and guidance; without todos but a
 *    "thought-only stop" (last assistant/message has only reasoning) it
 *    injects a todo-free continuation, unbounded. `pause_work` suppresses it.
 *
 * 配置来源(0.2.0-rc.2):插件不再自注册 settings 命名空间。配置由 Cordis
 * Loader 按下面导出的 `Config` schema 解析 profile patch 里的插件条目,设置
 * 界面由宿主按同一 schema 自动生成(只渲染 `.volatile()` 字段)。
 *
 * @module dsh-run-guard
 */
import z from '@deepseek-ai/schemastery';
import { applyGuard, applyGuardRecovery } from './guard.js';
import { applyContinue } from './continue.js';
import { debugLog } from './debug.js';
import { readConfig } from './config.js';

/** Plugin display name registered with the Cordis loader. */
export const name = 'dsh-run-guard';

/**
 * 插件版本,随每次发布同步 `package.json`(单测断言两者一致)。
 *
 * 写进加载日志是给运维用的:Node 的 ESM 模块缓存会让"改了代码但没重启"
 * 的进程继续跑旧代码,日志里带版本才能一眼确认当前跑的是哪一版。
 */
export const PLUGIN_VERSION = '0.2.1';

/**
 * Services consumed by this plugin. `tools`/`systemPrompt`/`agents`/`sessions`
 * are used by the continue half, `sessionPersistence` only for its todo
 * restore path; guard itself needs nothing but `ctx.on`.
 */
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'sessionPersistence'];

/**
 * Schemastery schema. The Cordis loader validates and default-fills it, and the
 * DSH settings shell derives its form from it — so every user-editable field is
 * marked `.volatile()`, which is what makes it appear in the form and stay
 * live-editable. A plugin reload on edit re-runs `apply` with the new values.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  guard: z.object({
    enabled: z.boolean().default(true).volatile(),
    windowChars: z.number().step(1).min(64).max(1000000).default(2000).volatile(),
    substrLen: z.number().step(1).min(8).max(128).default(32).volatile(),
    repeatRatio: z.number().min(0).max(1).default(0.7).volatile(),
    checkEvery: z.number().step(1).min(1).max(100000).default(50).volatile(),
    maxBlocks: z.number().step(1).min(100).default(10000).volatile(),
    maxChars: z.number().step(1).min(1000).default(500000).volatile(),
    maxGuardRetries: z.number().step(1).min(0).max(10).default(2).volatile(),
    autoRetryErrors: z.array(z.string()).default(['PI_AI_ERROR']).volatile(),
  }).default({}),
  continue: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxAutoFollowups: z.number().min(1).max(20).default(3).volatile(),
  }).default({}),
});

/**
 * Resolve a possibly-partial, possibly-volatile config to plain values.
 *
 * Mirrors the schema defaults so direct callers (tests, minimal hosts) can
 * bypass the Loader, and unwraps `Volatile` handles so both the Loader-supplied
 * volatile config and a plain object resolve identically.
 * @param {object | undefined} config - partial/volatile or complete/plain config.
 * @returns {object} complete resolved config of plain values.
 */
export function resolveConfig(config) {
  const guard = readConfig(config?.guard, {});
  const cont = readConfig(config?.continue, {});
  return {
    enabled: readConfig(config?.enabled, true),
    guard: {
      enabled: readConfig(guard.enabled, true),
      windowChars: readConfig(guard.windowChars, 2000),
      substrLen: readConfig(guard.substrLen, 32),
      repeatRatio: readConfig(guard.repeatRatio, 0.7),
      checkEvery: readConfig(guard.checkEvery, 50),
      maxBlocks: readConfig(guard.maxBlocks, 10000),
      maxChars: readConfig(guard.maxChars, 500000),
      maxGuardRetries: readConfig(guard.maxGuardRetries, 2),
      autoRetryErrors: readConfig(guard.autoRetryErrors, ['PI_AI_ERROR']),
    },
    continue: {
      enabled: readConfig(cont.enabled, true),
      maxAutoFollowups: readConfig(cont.maxAutoFollowups, 3),
    },
  };
}

/**
 * Cordis plugin entry: mount both halves under one resolved config.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - loader-validated plugin config (volatile fields are handles).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) {
    debugLog(`v${PLUGIN_VERSION} plugin disabled by config`);
    return;
  }
  // 子开关在挂载层生效:关闭的 half 完全不注册监听/工具
  if (resolved.guard.enabled) {
    applyGuard(ctx, resolved.guard);
    applyGuardRecovery(ctx, resolved.guard);
  }
  if (resolved.continue.enabled) applyContinue(ctx, resolved.continue);
  const summary = `v${PLUGIN_VERSION} guard=${resolved.guard.enabled} continue=${resolved.continue.enabled} maxGuardRetries=${resolved.guard.maxGuardRetries}`;
  ctx.logger?.info(`[dsh-run-guard] plugin loaded: ${summary}`);
  debugLog(`plugin loaded ${summary}`);
}
