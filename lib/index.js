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
 * 配置来源(0.2):插件不再自注册 settings 命名空间。配置由 Cordis Loader
 * 按下面导出的 `Config` schema 解析 profile patch 里的插件条目;配置表单
 * 由 client half 注册到 Plugins 页面并消费宿主下发的 `configForms`。
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
export const PLUGIN_VERSION = '0.2.2';

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
 * live-editable. The Loader commits volatile edits in place and emits
 * `loader/volatile-update`; the mount manager below responds to switch changes.
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

function liveConfig(config) {
  const defaults = resolveConfig();
  function view(source, fallback) {
    return new Proxy(fallback, {
      get(target, key) {
        const defaultValue = Reflect.get(target, key, target);
        const current = readConfig(source, fallback);
        const value = current?.[key];
        if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
          return view(value, defaultValue);
        }
        return readConfig(value, defaultValue);
      },
    });
  }
  return view(config, defaults);
}

/**
 * Cordis plugin entry: mount both halves under one live config view. The
 * Loader keeps a running fiber for volatile-only edits, so switch changes are
 * synchronized by `loader/volatile-update` while numeric values are read by
 * the mounted handlers on demand.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - loader-validated plugin config (volatile fields are handles).
 */
export function apply(ctx, config) {
  const live = liveConfig(config);
  let guardDispose;
  let recoveryDispose;
  let continueDispose;
  let disposed = false;

  const dispose = (key) => {
    const current = key === 'guard' ? guardDispose : key === 'recovery' ? recoveryDispose : continueDispose;
    if (typeof current === 'function') current();
    if (key === 'guard') guardDispose = undefined;
    else if (key === 'recovery') recoveryDispose = undefined;
    else continueDispose = undefined;
  };

  const sync = () => {
    if (disposed) return;
    const enabled = live.enabled !== false;
    if (!enabled || live.guard.enabled === false) {
      dispose('guard');
      dispose('recovery');
    } else {
      if (guardDispose === undefined) guardDispose = applyGuard(ctx, live.guard);
      if (recoveryDispose === undefined) recoveryDispose = applyGuardRecovery(ctx, live.guard);
    }
    if (!enabled || live.continue.enabled === false) {
      dispose('continue');
    } else if (continueDispose === undefined) {
      continueDispose = applyContinue(ctx, live.continue);
    }
  };

  sync();
  const removeVolatileListener = typeof ctx.on === 'function'
    ? ctx.on('loader/volatile-update', sync)
    : undefined;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    if (typeof removeVolatileListener === 'function') removeVolatileListener();
    dispose('continue');
    dispose('recovery');
    dispose('guard');
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeAll, 'dsh-run-guard: volatile mounts');
  } else {
    return disposeAll;
  }

  const summary = `v${PLUGIN_VERSION} guard=${live.enabled !== false && live.guard.enabled !== false} continue=${live.enabled !== false && live.continue.enabled !== false} maxGuardRetries=${live.guard.maxGuardRetries}`;
  ctx.logger?.info(`[dsh-run-guard] plugin loaded: ${summary}`);
  debugLog(`plugin loaded ${summary}`);
}
