/**
 * 配置解析测试(适配 dsh 0.2.0-rc.2)。
 *
 * 0.2 起插件不再自注册 settings 命名空间(`ctx.settings.register` 已删除):
 * 配置由 Cordis Loader 按插件导出的 `Config` schema 解析 profile patch 里的
 * 插件条目,设置界面由宿主按同一 schema 自动生成。这里覆盖:
 *  - `readConfig`/`isVolatile` 的解包语义(Volatile 句柄 vs 普通值)
 *  - `resolveConfig` 对 volatile 配置与普通配置给出一致结果
 *  - `Config` schema 的每个用户可编辑叶子字段都标记了 `.volatile()`
 *    (漏标记的字段不会出现在设置界面里,这是回归保护)
 *  - `apply` 在 volatile 配置下照常按子开关挂载
 * @module dsh-run-guard/test/settings
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveConfig, Config } from '../lib/index.js';
import { isVolatile, readConfig } from '../lib/config.js';

/** 鸭子类型的 Volatile 句柄(与 cosmokit `createVolatile` 的可观测形状一致)。 */
const vol = (value) => ({ get: () => value });

/** 完整 ctx:足以让两个 half 都挂载。 */
function createFullCtx() {
  const listeners = new Map();
  const contextDefs = [];
  const tools = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context: (def) => contextDefs.push(def) },
    tools: { register: (def) => tools.push(def) },
    agents: { get: () => undefined },
    sessions: { get: () => ({ append: () => {} }) },
    sessionPersistence: {
      open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
    },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _contextDefs: contextDefs,
    _tools: tools,
  };
  return ctx;
}

/** 收集 schema 的所有叶子字段及其 volatile 标记。 */
function leafFields(schema, path = [], out = []) {
  if (schema.type === 'object' && schema.dict !== undefined) {
    for (const [key, child] of Object.entries(schema.dict)) leafFields(child, [...path, key], out);
    return out;
  }
  out.push({ path: path.join('.'), volatile: schema.meta?.volatile === true });
  return out;
}

// ───────────────────────── readConfig / isVolatile ─────────────────────────

test('isVolatile:只认带 get() 的非数组对象', () => {
  assert.equal(isVolatile(vol(1)), true);
  assert.equal(isVolatile({ get: () => 1 }), true);
  assert.equal(isVolatile({}), false);
  assert.equal(isVolatile([1, 2]), false);
  assert.equal(isVolatile(null), false);
  assert.equal(isVolatile(undefined), false);
  assert.equal(isVolatile(true), false);
  assert.equal(isVolatile('x'), false);
});

test('readConfig:解包句柄、保留普通值、undefined 用 fallback', () => {
  assert.equal(readConfig(vol(false), true), false, '应解包句柄');
  assert.equal(readConfig(true, false), true, '普通值原样返回');
  assert.equal(readConfig(undefined, 42), 42, 'undefined 用 fallback');
  assert.equal(readConfig(null, 42), null, 'null 是显式值,不替换');
  assert.deepEqual(readConfig(vol(['A']), []), ['A']);
  assert.deepEqual(readConfig(['A'], []), ['A'], '数组不被当作句柄');
});

// ───────────────────────── resolveConfig ─────────────────────────

test('resolveConfig:volatile 配置与普通配置结果一致', () => {
  const plain = resolveConfig({ enabled: false, guard: { maxGuardRetries: 5 }, continue: { enabled: false } });
  const volatile = resolveConfig({
    enabled: vol(false),
    guard: { maxGuardRetries: vol(5), autoRetryErrors: vol(['X']) },
    continue: { enabled: vol(false), maxAutoFollowups: vol(7) },
  });
  assert.equal(volatile.enabled, false);
  assert.equal(volatile.guard.maxGuardRetries, 5);
  assert.equal(volatile.continue.enabled, false);
  assert.equal(volatile.continue.maxAutoFollowups, 7);
  assert.deepEqual(volatile.guard.autoRetryErrors, ['X']);
  // 未覆盖字段保持 schema 默认
  assert.equal(volatile.guard.windowChars, 2000);
  assert.equal(volatile.guard.enabled, true);
  // 与普通配置的差异仅在显式覆盖处
  assert.equal(plain.guard.maxGuardRetries, volatile.guard.maxGuardRetries);
  assert.equal(plain.continue.enabled, volatile.continue.enabled);
});

test('resolveConfig:空配置填满默认值', () => {
  const c = resolveConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.guard.enabled, true);
  assert.equal(c.guard.repeatRatio, 0.7);
  assert.equal(c.guard.maxBlocks, 10000);
  assert.equal(c.guard.maxChars, 500000);
  assert.equal(c.guard.maxGuardRetries, 2);
  assert.deepEqual(c.guard.autoRetryErrors, ['PI_AI_ERROR']);
  assert.equal(c.continue.enabled, true);
  assert.equal(c.continue.maxAutoFollowups, 3);
});

// ───────────────────────── Config schema 回归保护 ─────────────────────────

test('Config:每个叶子字段都标记 volatile(否则不会出现在设置界面)', () => {
  const leaves = leafFields(Config);
  assert.ok(leaves.length >= 12, `应至少有 12 个可编辑字段,实际 ${leaves.length}`);
  const missing = leaves.filter((leaf) => !leaf.volatile).map((leaf) => leaf.path);
  assert.deepEqual(missing, [], `未标记 volatile 的字段不会进设置界面: ${missing.join(', ')}`);
});

test('Config:声明的字段名与 resolveConfig 读取的字段一致', () => {
  const leaves = leafFields(Config).map((leaf) => leaf.path).sort();
  const expected = [
    'continue.enabled',
    'continue.maxAutoFollowups',
    'enabled',
    'guard.autoRetryErrors',
    'guard.checkEvery',
    'guard.enabled',
    'guard.maxBlocks',
    'guard.maxChars',
    'guard.maxGuardRetries',
    'guard.repeatRatio',
    'guard.substrLen',
    'guard.windowChars',
  ];
  assert.deepEqual(leaves, expected);
});

// ───────────────────────── apply 与 volatile 配置 ─────────────────────────

test('apply:volatile 配置下子开关照常生效', () => {
  const ctx = createFullCtx();
  apply(ctx, { enabled: vol(true), guard: { enabled: vol(false) }, continue: { enabled: vol(true) } });
  assert.equal(ctx._listeners('llm/stream').length, 0, 'guard 关闭时不注册流监听');
  assert.equal(ctx._listeners('agent/request-error').length, 0, 'guard 关闭时不注册 recovery');
  assert.ok(ctx._tools.some((t) => t.name === 'pause_work'), 'continue 仍挂载');
});

test('apply:volatile enabled=false 时什么都不挂载', () => {
  const ctx = createFullCtx();
  apply(ctx, { enabled: vol(false) });
  assert.equal(ctx._listeners('llm/stream').length, 0);
  assert.equal(ctx._tools.length, 0);
  assert.equal(ctx._contextDefs.length, 0);
  assert.equal(ctx._listeners('session/event').length, 0);
});

test('apply:volatile 配置值参与运行时决策(maxGuardRetries)', async () => {
  const ctx = createFullCtx();
  apply(ctx, { guard: { maxGuardRetries: vol(3) } });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  const payload = () => ({
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    provider: 'p',
    failure: { message: 'x', code: 'REASONING_GUARD' },
    signal: new AbortController().signal,
  });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await listener(payload(), next), { kind: 'retry' }, `第 ${i + 1} 次应重试`);
  }
  assert.equal(await listener(payload(), next), undefined, '第 4 次超限');
});
