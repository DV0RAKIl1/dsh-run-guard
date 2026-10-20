/**
 * Merge-entry smoke tests: `apply` mounts both halves (guard + continue)
 * under one config, and the master switch disables everything.
 * @module dsh-run-guard/test/index
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply, resolveConfig, name, PLUGIN_VERSION } from '../lib/index.js';

/** Full Cordis-like context serving both halves. */
function createFullCtx() {
  const listeners = new Map();
  const contextDefs = [];
  const tools = [];
  const effectDisposers = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      const list = listeners.get(name);
      list.push(fn);
      return () => {
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') effectDisposers.push(disposer);
      return disposer;
    },
    systemPrompt: {
      context: (def) => {
        contextDefs.push(def);
        return () => {
          const index = contextDefs.indexOf(def);
          if (index >= 0) contextDefs.splice(index, 1);
        };
      },
    },
    tools: {
      register: (def) => {
        tools.push(def);
        return () => {
          const index = tools.indexOf(def);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    },
    agents: { get: () => undefined },
    sessions: { get: () => ({ append: () => {} }) },
    sessionPersistence: {
      open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
    },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
    },
    _contextDefs: contextDefs,
    _tools: tools,
    _disposeEffects() {
      for (const dispose of effectDisposers.splice(0).reverse()) dispose();
    },
  };
  return ctx;
}

test('插件名称为 dsh-run-guard', () => {
  assert.equal(name, 'dsh-run-guard');
});

test('PLUGIN_VERSION 与 package.json 一致(加载日志靠它辨别跑的是哪一版)', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test('apply 挂载两个 half:llm/stream 监听 + pause_work 工具 + systemPrompt context', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  assert.equal(ctx._listeners('llm/stream').length, 1, 'guard 注册 llm/stream 监听');
  assert.ok(ctx._tools.some((t) => t.name === 'pause_work'), 'continue 注册 pause_work 工具');
  assert.ok(ctx._contextDefs.some((d) => d.name === 'dsh-run-guard:todo-status'), 'continue 注册 systemPrompt context');
  assert.ok(ctx._listeners('session/event').length >= 1, 'continue 注册 session/event 监听');
});

test('热重载释放旧的 systemPrompt context 和 pause_work 工具', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig());
  assert.equal(ctx._contextDefs.length, 1);
  assert.equal(ctx._tools.length, 1);

  ctx._disposeEffects();
  assert.equal(ctx._contextDefs.length, 0);
  assert.equal(ctx._tools.length, 0);

  apply(ctx, resolveConfig());
  assert.equal(ctx._contextDefs.length, 1);
  assert.equal(ctx._tools.length, 1);
});

test('enabled=false 时什么都不挂载', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig({ enabled: false }));
  assert.equal(ctx._listeners('llm/stream').length, 0);
  assert.equal(ctx._tools.length, 0);
  assert.equal(ctx._contextDefs.length, 0);
  assert.equal(ctx._listeners('session/event').length, 0);
});

test('子开关:guard.enabled=false 只挂 continue', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig({ guard: { enabled: false } }));
  assert.equal(ctx._listeners('llm/stream').length, 0, 'guard 关闭时不注册流监听');
  assert.ok(ctx._tools.some((t) => t.name === 'pause_work'), 'continue 仍挂载');
});

test('子开关:continue.enabled=false 只挂 guard', () => {
  const ctx = createFullCtx();
  apply(ctx, resolveConfig({ continue: { enabled: false } }));
  assert.equal(ctx._listeners('llm/stream').length, 1, 'guard 仍挂载');
  assert.equal(ctx._tools.length, 0, 'continue 关闭时不注册工具');
  assert.equal(ctx._contextDefs.length, 0);
});

test('loader/volatile-update 动态卸载并重新挂载两 half', () => {
  const enabled = { value: true, get() { return this.value; } };
  const guardEnabled = { value: true, get() { return this.value; } };
  const continueEnabled = { value: true, get() { return this.value; } };
  const ctx = createFullCtx();
  apply(ctx, {
    enabled,
    guard: { enabled: guardEnabled },
    continue: { enabled: continueEnabled },
  });
  assert.equal(ctx._listeners('llm/stream').length, 1);
  assert.equal(ctx._tools.length, 1);

  enabled.value = false;
  ctx._emit('loader/volatile-update', [['enabled']]);
  assert.equal(ctx._listeners('llm/stream').length, 0, '关闭总开关后 guard 监听应卸载');
  assert.equal(ctx._listeners('agent/request-error').length, 0, '关闭总开关后 recovery 监听应卸载');
  assert.equal(ctx._listeners('session/event').length, 0, '关闭总开关后 continue 监听应卸载');
  assert.equal(ctx._tools.length, 0);
  assert.equal(ctx._contextDefs.length, 0);

  enabled.value = true;
  ctx._emit('loader/volatile-update', [['enabled']]);
  assert.equal(ctx._listeners('llm/stream').length, 1, '重新开启后 guard 应重新挂载');
  assert.equal(ctx._listeners('agent/request-error').length, 1, '重新开启后 recovery 应重新挂载');
  assert.equal(ctx._listeners('session/event').length, 2, 'guard 与 continue 各有一个 session listener');
  assert.equal(ctx._tools.length, 1);
  assert.equal(ctx._contextDefs.length, 1);
});

test('resolveConfig 填充嵌套默认值', () => {
  const c = resolveConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.guard.repeatRatio, 0.7);
  assert.equal(c.guard.maxBlocks, 10000);
  assert.equal(c.continue.maxAutoFollowups, 3);
  // 部分覆盖
  const c2 = resolveConfig({ guard: { maxBlocks: 500 }, continue: { enabled: false } });
  assert.equal(c2.guard.maxBlocks, 500);
  assert.equal(c2.guard.windowChars, 2000, '未覆盖字段保持默认');
  assert.equal(c2.continue.enabled, false);
});
