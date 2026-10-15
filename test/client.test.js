/**
 * client half 测试：在 Node 里用 mock 的 module loader / primitives 求值
 * client bundle，并用 react-dom/server 渲染配置卡片。
 *
 * 覆盖：
 *  - bundle 注册 id、apply/inject 形状
 *  - 注册到 `plugins.row.config`，key 为 `<包名>#<行 id>`
 *  - 字段表与 Host `Config` schema 的叶子字段一一对应（防脱节）
 *  - `view: 'summary'` / `view: 'page'` 两条分支
 *  - 不可写（readOnly）时表单仍然渲染
 * @module dsh-run-guard/test/client
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Config } from '../lib/index.js';

/** client.js 里声明的全部字段路径。 */
function clientFieldPaths(fields) {
  return fields.map((field) => field.path.join('.')).sort();
}

/** Host Config schema 的叶子字段路径。 */
function schemaLeafPaths(schema, prefix = [], out = []) {
  if (schema.type === 'object' && schema.dict !== undefined) {
    for (const [key, child] of Object.entries(schema.dict)) schemaLeafPaths(child, [...prefix, key], out);
    return out;
  }
  out.push(prefix.join('.'));
  return out;
}

/** 求值 client bundle：捕获 __ModuleLoader__ 注册，再用 mock require 调用 factory。
 * ESM 模块只执行一次，因此注册结果在多次调用间复用。 */
let clientRegistration;
async function loadClientModule() {
  if (clientRegistration === undefined) {
    globalThis.window = { __ModuleLoader__: { load: (definition) => { clientRegistration = definition; } } };
    await import('../lib/client.js');
  }
  assert.ok(clientRegistration !== undefined, 'client bundle 应调用 __ModuleLoader__.load');
  const registration = clientRegistration;
  const primitives = {
    SettingsForm: (props) => React.createElement('div', { 'data-settings-form': '' }, props.children),
    SettingsValueField: (props) => React.createElement('label', null, props.label),
    Switch: (props) => React.createElement('button', { 'data-switch': String(props.checked) }, props.label),
  };
  const fakeRequire = (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require: ${name}`);
  };
  return { registration, module: registration.factory(fakeRequire) };
}

/** 挂载 client half 的 mock 客户端上下文。 */
function mountClient(module, snapshot) {
  const registered = [];
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
  };
  const ctx = {
    configForms: {
      get: (ns) => {
        assert.equal(ns, 'run-guard');
        return form;
      },
      whileServed: (namespaces, register) => {
        assert.deepEqual(namespaces, ['run-guard']);
        register(new Set(namespaces));
        return () => {};
      },
    },
    slots: {
      inject: (name, callback) => {
        assert.equal(name, 'plugins.row.config');
        callback();
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
    effect: (factory) => {
      factory();
    },
  };
  module.apply(ctx);
  assert.equal(registered.length, 1, '应注册一个配置卡片');
  return registered[0];
}

const READY_SNAPSHOT = {
  status: 'ready',
  value: {
    enabled: true,
    guard: {
      enabled: true,
      windowChars: 2000,
      substrLen: 32,
      repeatRatio: 0.7,
      checkEvery: 50,
      maxBlocks: 10000,
      maxChars: 500000,
      maxGuardRetries: 2,
      autoRetryErrors: ['PI_AI_ERROR'],
    },
    continue: { enabled: true, maxAutoFollowups: 3 },
  },
  base: {},
  user: undefined,
  revision: 3,
  writable: true,
  mode: 'host',
};

test('client bundle 注册 id 与 apply/inject 形状', async () => {
  const { registration, module } = await loadClientModule();
  assert.equal(registration.id, 'dsh-run-guard');
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual(module.inject, ['slots', 'configForms']);
});

test('注册到 plugins.row.config,key 为 <包名>#<行 id>', async () => {
  const { module } = await loadClientModule();
  const { options } = mountClient(module, READY_SNAPSHOT);
  assert.equal(options.name, 'plugins.row.config');
  assert.equal(options.key, 'dsh-run-guard#run-guard');
});

test('字段表与 Host Config schema 的叶子字段一一对应', async () => {
  const { module } = await loadClientModule();
  assert.deepEqual(
    clientFieldPaths(module.__fields),
    schemaLeafPaths(Config).sort(),
    'client 字段表与 Config schema 脱节时，设置界面会缺字段或写出无效路径',
  );
});

test('view=summary 渲染一行描述', async () => {
  const { module } = await loadClientModule();
  const { component } = mountClient(module, READY_SNAPSHOT);
  const html = renderToStaticMarkup(React.createElement(component, { view: 'summary' }));
  assert.ok(html.includes('推理死循环拦截'), `应渲染描述,实际: ${html}`);
  assert.ok(!html.includes('data-settings-form'), 'summary 不渲染表单');
});

test('view=page 渲染全部字段与表单外壳', async () => {
  const { module } = await loadClientModule();
  const { component } = mountClient(module, READY_SNAPSHOT);
  const html = renderToStaticMarkup(React.createElement(component, { view: 'page' }));
  assert.ok(html.includes('data-settings-form'), '应渲染表单外壳');
  for (const field of module.__fields) {
    assert.ok(html.includes(field.label), `缺少字段标签: ${field.label}`);
  }
  assert.ok(html.includes('Guard · 死循环拦截'), '应渲染分组标题');
  assert.ok(html.includes('Continue · 自动继续'), '应渲染分组标题');
});

test('布尔字段按 snapshot 值渲染开关状态', async () => {
  const { module } = await loadClientModule();
  const { component } = mountClient(module, {
    ...READY_SNAPSHOT,
    value: { ...READY_SNAPSHOT.value, enabled: false, continue: { enabled: true, maxAutoFollowups: 3 } },
  });
  const html = renderToStaticMarkup(React.createElement(component, { view: 'page' }));
  assert.ok(html.includes('data-switch="false"'), '总开关应渲染为关闭');
  assert.ok(html.includes('data-switch="true"'), '自动继续应渲染为开启');
});

test('只读部署:表单仍渲染(外壳负责提示只读)', async () => {
  const { module } = await loadClientModule();
  const { component } = mountClient(module, { ...READY_SNAPSHOT, writable: false });
  const html = renderToStaticMarkup(React.createElement(component, { view: 'page' }));
  assert.ok(html.includes('data-settings-form'), '只读时仍应渲染表单(禁用态)');
});

test('命名空间不可用:仍渲染外壳,由外壳显示不可用提示', async () => {
  const { module } = await loadClientModule();
  const { component } = mountClient(module, { ...READY_SNAPSHOT, status: 'unavailable', value: undefined });
  const html = renderToStaticMarkup(React.createElement(component, { view: 'page' }));
  assert.ok(html.includes('data-settings-form'), '不可用时外壳仍在');
});
