/**
 * Guard recovery tests: `agent/request-error` auto-retry after a guard fire.
 * @module dsh-run-guard/test/recovery
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGuardRecovery, REASONING_GUARD_CODE } from '../lib/guard.js';
import { apply, resolveConfig } from '../lib/index.js';

const session = { id: 's1' };
const ev = (type, data) => ({ type, data });

function createCtx() {
  const listeners = new Map();
  const logs = [];
  const ctx = {
    logger: { warn: (...a) => logs.push(['warn', ...a]), info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _logs: logs,
  };
  return ctx;
}

/** 构造 request-error payload。 */
function errorPayload(overrides = {}) {
  return {
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    provider: 'opencode',
    failure: { message: 'x', code: REASONING_GUARD_CODE },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('REASONING_GUARD:前 maxGuardRetries 次返回 retry,超限返回 undefined', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined; // 模拟 llm-retry 不干预

  const r1 = await listener(errorPayload(), next);
  assert.deepEqual(r1, { kind: 'retry' }, '第 1 次应重试');
  const r2 = await listener(errorPayload(), next);
  assert.deepEqual(r2, { kind: 'retry' }, '第 2 次应重试');
  const r3 = await listener(errorPayload(), next);
  assert.equal(r3, undefined, '第 3 次(超限)不再重试');
  assert.ok(ctx._logs.some((l) => l[1].includes('自动重试 1/2')), '应记录重试日志');
});

test('非 REASONING_GUARD 错误:调用 next() 不干预', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  let nextCalled = 0;
  const next = async () => { nextCalled++; return undefined; };
  const r = await listener(errorPayload({ failure: { message: 'x', code: 'SERVER' } }), next);
  assert.equal(nextCalled, 1, '应把非 guard 错误交给下游');
  assert.equal(r, undefined);
});

test('turn/end 清理计数:新 turn 重新计数', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 1 });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  // turn 1:1 次重试后超限
  assert.deepEqual(await listener(errorPayload({ turn: 1 }), next), { kind: 'retry' });
  assert.equal(await listener(errorPayload({ turn: 1 }), next), undefined);
  // turn 1 结束清理
  emit(session, ev('turn/end', { turn: 1 }));
  // turn 2:重新计数
  assert.deepEqual(await listener(errorPayload({ turn: 2 }), next), { kind: 'retry' });
  assert.equal(await listener(errorPayload({ turn: 2 }), next), undefined);
});

test('不同 turn 计数隔离', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  // turn 1 两次(超限)
  assert.deepEqual(await listener(errorPayload({ turn: 1 }), next), { kind: 'retry' });
  assert.deepEqual(await listener(errorPayload({ turn: 1 }), next), { kind: 'retry' });
  assert.equal(await listener(errorPayload({ turn: 1 }), next), undefined);
  // turn 2 不受影响
  assert.deepEqual(await listener(errorPayload({ turn: 2 }), next), { kind: 'retry' });
});

test('maxGuardRetries=0:禁用自动重试,立即 undefined', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 0 });
  const listener = ctx._listeners('agent/request-error')[0];
  const r = await listener(errorPayload(), async () => undefined);
  assert.equal(r, undefined, '0 表示不自动重试');
});

test('agent 缺失:不干预', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2 });
  const listener = ctx._listeners('agent/request-error')[0];
  let nextCalled = 0;
  const r = await listener(errorPayload({ agent: undefined }), async () => { nextCalled++; return undefined; });
  assert.equal(nextCalled, 1);
  assert.equal(r, undefined);
});

test('合并入口:apply 挂载 recovery(guard.enabled 时注册 agent/request-error)', () => {
  const ctx = createCtx();
  // 需要完整 ctx(apply 会调 applyContinue)
  ctx.systemPrompt = { context: () => {} };
  ctx.tools = { register: () => {} };
  ctx.agents = { get: () => undefined };
  ctx.sessions = { get: () => ({ append: () => {} }) };
  ctx.sessionPersistence = {
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
  };
  apply(ctx, resolveConfig({}));
  assert.ok(ctx._listeners('agent/request-error').length >= 1, 'guard 开启时应注册 recovery');
  // guard.enabled=false 时不注册
  const ctx2 = createCtx();
  ctx2.systemPrompt = { context: () => {} };
  ctx2.tools = { register: () => {} };
  ctx2.agents = { get: () => undefined };
  ctx2.sessions = { get: () => ({ append: () => {} }) };
  ctx2.sessionPersistence = {
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
  };
  apply(ctx2, resolveConfig({ guard: { enabled: false } }));
  assert.equal(ctx2._listeners('agent/request-error').length, 0, 'guard 关闭时不注册 recovery');
});

test('resolveConfig 默认 maxGuardRetries=2,可覆盖', () => {
  const c = resolveConfig({});
  assert.equal(c.guard.maxGuardRetries, 2);
  const c2 = resolveConfig({ guard: { maxGuardRetries: 5 } });
  assert.equal(c2.guard.maxGuardRetries, 5);
});

test('autoRetryErrors:白名单内的上游错误(如 PI_AI_ERROR)自动重试', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2, autoRetryErrors: ['PI_AI_ERROR'] });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  const payload = errorPayload({ failure: { message: 'Upstream request failed', code: 'PI_AI_ERROR' } });
  assert.deepEqual(await listener(payload, next), { kind: 'retry' }, 'PI_AI_ERROR 第 1 次应重试');
  assert.deepEqual(await listener(payload, next), { kind: 'retry' }, '第 2 次应重试');
  assert.equal(await listener(payload, next), undefined, '第 3 次超限停止');
  assert.ok(ctx._logs.some((l) => l[1].includes('请求失败(PI_AI_ERROR)')), '日志应标注请求失败类型');
});

test('autoRetryErrors 之外的上游错误:不干预', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2, autoRetryErrors: ['PI_AI_ERROR'] });
  const listener = ctx._listeners('agent/request-error')[0];
  let nextCalled = 0;
  const r = await listener(
    errorPayload({ failure: { message: 'x', code: 'OTHER_UPSTREAM_ERROR' } }),
    async () => { nextCalled++; return undefined; }
  );
  assert.equal(nextCalled, 1, '白名单外交给下游');
  assert.equal(r, undefined);
});

test('REASONING_GUARD 恒可重试(autoRetryErrors 不含它也生效)', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 1, autoRetryErrors: [] }); // 白名单空
  const listener = ctx._listeners('agent/request-error')[0];
  const r = await listener(errorPayload(), async () => undefined);
  assert.deepEqual(r, { kind: 'retry' }, 'REASONING_GUARD 不受 autoRetryErrors 影响');
});

test('持久错误(AUTH/QUOTA)永不自动重试', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 2, autoRetryErrors: ['PI_AI_ERROR'] });
  const listener = ctx._listeners('agent/request-error')[0];
  for (const code of ['AUTH', 'QUOTA', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED']) {
    let nextCalled = 0;
    const r = await listener(errorPayload({ failure: { message: 'x', code } }), async () => { nextCalled++; return undefined; });
    assert.equal(nextCalled, 1, `${code} 应交由下游`);
    assert.equal(r, undefined);
  }
});

test('resolveConfig 默认 autoRetryErrors=[PI_AI_ERROR],可覆盖', () => {
  const c = resolveConfig({});
  assert.deepEqual(c.guard.autoRetryErrors, ['PI_AI_ERROR']);
  const c2 = resolveConfig({ guard: { autoRetryErrors: ['X_ERROR'] } });
  assert.deepEqual(c2.guard.autoRetryErrors, ['X_ERROR']);
});

// ───────────────── llm/retry 事件的链语义(会话日志格式校验) ─────────────────
//
// dsh 把 `llm/retry.retry` 定义为 (turn, step, provider, policyKey) 这条
// provider-policy 链上的尝试序号:必须从 1 开始连续,且同一条链上的 retryId
// 必须保持不变。按 per-turn 计数写会在"同一 turn 的第二次中断换了 step"时
// 写出 retry=2 的新链,使会话日志被判定损坏 —— 以下用例锁住这个修复。

/** 记录 llm/retry append 的 session。 */
function sessionHarness() {
  const appended = [];
  const session = { id: 's1', append: (type, data) => appended.push({ type, data }) };
  return { appended, session };
}

test('llm/retry 同一 step 链内:序号连续、retryId 固定', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 3 });
  const listener = ctx._listeners('agent/request-error')[0];
  const { appended, session } = sessionHarness();
  const next = async () => undefined;
  const payload = () => errorPayload({ agent: { id: 's1', session }, turn: 1, step: 7 });

  for (let i = 0; i < 3; i++) assert.deepEqual(await listener(payload(), next), { kind: 'retry' });

  assert.equal(appended.length, 3);
  assert.deepEqual(appended.map((a) => a.type), ['llm/retry', 'llm/retry', 'llm/retry']);
  assert.deepEqual(appended.map((a) => a.data.retry), [1, 2, 3]);
  assert.deepEqual(appended.map((a) => a.data.retryId), [
    'run-guard:[1,7,"opencode","dsh-run-guard:auto-retry"]',
    'run-guard:[1,7,"opencode","dsh-run-guard:auto-retry"]',
    'run-guard:[1,7,"opencode","dsh-run-guard:auto-retry"]',
  ]);
  assert.ok(appended.every((a) => a.data.turn === 1 && a.data.step === 7));
  assert.ok(appended.every((a) => a.data.retry <= a.data.maxRetries), 'retry 不得超过 maxRetries');
  assert.ok(appended.every((a) => a.data.mode === 'normal' && a.data.policyKey === 'dsh-run-guard:auto-retry'));
});

test('换 step 即新链:retry 从 1 重新开始(会话损坏的回归点)', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 3 });
  const listener = ctx._listeners('agent/request-error')[0];
  const { appended, session } = sessionHarness();
  const next = async () => undefined;

  // 同一 turn 内:step 34 中断一次 → 重试后模型跑到 step 47 又中断
  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 34 }), next);
  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 47 }), next);

  assert.deepEqual(appended.map((a) => a.data.retry), [1, 1], '新 step 是一条新链,retry 必须从 1 开始');
  assert.deepEqual(appended.map((a) => a.data.retryId), [
    'run-guard:[1,34,"opencode","dsh-run-guard:auto-retry"]',
    'run-guard:[1,47,"opencode","dsh-run-guard:auto-retry"]',
  ], '不同链不得共用 retryId');
});

test('provider failover 开启独立 retry 链:不复用序号和 retryId', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 3 });
  const listener = ctx._listeners('agent/request-error')[0];
  const { appended, session } = sessionHarness();
  const next = async () => undefined;

  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 7, provider: 'opencode' }), next);
  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 7, provider: 'openai' }), next);
  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 7, provider: 'openai' }), next);

  assert.deepEqual(appended.map((a) => a.data.provider), ['opencode', 'openai', 'openai']);
  assert.deepEqual(appended.map((a) => a.data.retry), [1, 1, 2]);
  assert.deepEqual(appended.map((a) => a.data.retryId), [
    'run-guard:[1,7,"opencode","dsh-run-guard:auto-retry"]',
    'run-guard:[1,7,"openai","dsh-run-guard:auto-retry"]',
    'run-guard:[1,7,"openai","dsh-run-guard:auto-retry"]',
  ]);
});

test('超过 maxGuardRetries:不再写 llm/retry', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 1 });
  const listener = ctx._listeners('agent/request-error')[0];
  const { appended, session } = sessionHarness();
  const next = async () => undefined;
  const payload = () => errorPayload({ agent: { id: 's1', session }, turn: 1, step: 3 });

  assert.deepEqual(await listener(payload(), next), { kind: 'retry' });
  assert.equal(await listener(payload(), next), undefined, '超限后不再重试');
  assert.equal(appended.length, 1, '超限的那次不应留下 llm/retry');
});

test('turn/end 清理链计数:新 turn 的同 step 重新从 1 开始', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 3 });
  const listener = ctx._listeners('agent/request-error')[0];
  const { appended, session } = sessionHarness();
  const next = async () => undefined;
  const emit = (s, e) => { for (const fn of ctx._listeners('session/event')) fn(s, e); };

  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 5 }), next);
  await listener(errorPayload({ agent: { id: 's1', session }, turn: 1, step: 5 }), next);
  emit(session, ev('turn/end', { turn: 1 }));
  await listener(errorPayload({ agent: { id: 's1', session }, turn: 2, step: 5 }), next);

  assert.deepEqual(appended.map((a) => a.data.retry), [1, 2, 1]);
  assert.deepEqual(appended.map((a) => a.data.retryId), [
    'run-guard:[1,5,"opencode","dsh-run-guard:auto-retry"]',
    'run-guard:[1,5,"opencode","dsh-run-guard:auto-retry"]',
    'run-guard:[2,5,"opencode","dsh-run-guard:auto-retry"]',
  ]);
});

test('不同会话的链计数互相隔离', async () => {
  const ctx = createCtx();
  applyGuardRecovery(ctx, { maxGuardRetries: 3 });
  const listener = ctx._listeners('agent/request-error')[0];
  const a = sessionHarness();
  const b = sessionHarness();
  const next = async () => undefined;

  await listener(errorPayload({ agent: { id: 's1', session: a.session }, turn: 1, step: 9 }), next);
  await listener(errorPayload({ agent: { id: 's2', session: b.session }, turn: 1, step: 9 }), next);
  await listener(errorPayload({ agent: { id: 's1', session: a.session }, turn: 1, step: 9 }), next);

  assert.deepEqual(a.appended.map((x) => x.data.retry), [1, 2]);
  assert.deepEqual(b.appended.map((x) => x.data.retry), [1]);
});
