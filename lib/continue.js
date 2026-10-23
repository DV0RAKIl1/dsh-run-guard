// dsh-run-guard/continue：自动继续执行(迁移自 todo-continue)
//
// 两层机制：
// 1. 预防层：ctx.systemPrompt.context 动态注入——turn 内每轮模型请求组装时，
//    若会话存在未完成 todo，注入 todo 状态与 pause_work 引导（空文本不注入）。
// 2. 兜底层：turn/end（仅 reason.kind === 'completed'）后自动继续，分两路：
//    a. 有未完成 todo：注入 todo 状态与引导并唤醒新 turn（有计数上限）；
//    b. 无 todo 但"想完就停"（本 turn 最后一条 assistant/message 只有 reasoning
//       块，无正文无工具调用）：注入不含 todo 信息的提示并唤醒新 turn（无上限）。
//
// 模型主动暂停：调用 pause_work 工具，本 turn 结束后不自动继续（两路都不触发）。
//
// 关键约束：
// - followup 必须在 setTimeout(0) 中执行——turn/end 的 session/event 分发期间
//   调用 session append 会抛 "cannot reenter while another append is being published"。
// - 计数语义（仅 todo 场景）：模型本 turn 有实质产出（工具调用或正文块）视为在推进，
//   重置连续计数；无产出（只思考就结束）才累计，达到 maxAutoFollowups 后停止。
// - 重启恢复：todo 状态从持久化会话日志（最近一条 todo/write）惰性重建。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { debugLog } from './debug.js';

const MAX_LISTED = 5;

/**
 * 本插件注入消息的 source kind。
 *
 * 0.2 移除了通用的 `plugin` source kind,改为每个生产者声明自己的
 * kind(`MessageSourceMap` 是 merge-extensible 的)。这里声明 `run-guard`,
 * 同时用 `form: 'notice'` 告诉消费端这是一条一次性告知,附一行摘要。
 */
const SOURCE_KIND = 'run-guard';

/** 本插件注入消息在 UI 折叠行上显示的一行摘要。 */
const SOURCE_SUMMARY = 'run-guard 自动继续';

export function applyContinue(ctx, config) {
  // `config` may be a Loader volatile view. Read fields at event time so live
  // edits take effect without relying on apply() being called again.
  let disposed = false;

  // sessionId -> todos[]（todo/write 全量快照，last-write-wins，跨 turn 保留）
  const todoState = new Map();
  // sessionId 集合：本 turn 内模型调用了 pause_work
  const pauseMarks = new Set();
  // sessionId -> 连续无产出次数（有产出/用户输入时重置）
  const autoFollowupCount = new Map();
  // sessionId -> 本 turn 内模型是否有实质产出（工具调用或非空文本）
  const producedThisTurn = new Map();
  // sessionId -> { firstMessage, modelWrote }——turn 内标志（UI 投影恢复用）
  const turnFlags = new Map();
  // sessionId：turn/end 已注入 followup，期待下个 turn 消费（恢复 UI 计划条）
  const pendingRestore = new Set();
  // sessionId -> 本 turn 最后一条 assistant/message 的输出状态（"无实质产出"判定）
  const lastAssistantState = new Map();

  /** 正文块只有非空白文本才算实质产出；工具调用始终算产出。 */
  function hasSubstantiveContent(content) {
    return Array.isArray(content) && content.some((block) =>
      block?.type === 'tool-call' ||
      (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
    );
  }

  /** 该会话未完成（非 completed）的 todo 列表。 */
  function pendingTodos(sessionId) {
    const todos = todoState.get(sessionId);
    if (!todos || todos.length === 0) return [];
    return todos.filter((t) => t.status !== 'completed');
  }

  /** 未完成列表渲染：最多 MAX_LISTED 项，超出省略。 */
  function renderOpen(open) {
    const listed = open.slice(0, MAX_LISTED).map((t, i) => `${i + 1}. ${t.content}`).join('\n');
    const more = open.length > MAX_LISTED ? `\n…等 ${open.length - MAX_LISTED} 项` : '';
    return { listed, more };
  }

  /** 兜底提示词（turn 后注入）。 */
  function buildFollowupText(open) {
    const { listed, more } = renderOpen(open);
    return [
      `检测到还有未完成的 todo（${open.length} 项）：`,
      listed + more,
      '',
      '请继续执行，并【及时更新 todo 状态】——每完成一项就调用 todo_write 标记 completed，不要等全部完成才更新。',
      '如果确实需要暂停当前任务（如等待用户输入、外部依赖、需要用户决策），请调用 pause_work 工具——调用后本 turn 结束将不会自动继续。',
    ].join('\n');
  }

  /** 无 todo 场景的继续提示（不含 todo 信息，简洁精准）。 */
  function buildNoTodoFollowupText() {
    return [
      '检测到你本轮仅输出推理或空白文本，没有正文或工具调用。',
      '请继续完成当前任务；如确实需要暂停（等待用户输入、外部依赖、需要用户决策），请调用 pause_work 工具。',
    ].join('\n');
  }

  /** 向会话注入提示消息并唤醒新 turn（必须在 setTimeout(0) 中执行，避免重入冲突）。 */
  function followupWith(sessionId, text) {
    const agent = ctx.agents.get(sessionId);
    if (!agent) return;
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: SOURCE_SUMMARY },
    });
    setTimeout(() => {
      try {
        agent.followup(msg);
      } catch {
        // followup 失败不影响后续 turn
      }
    }, 0);
  }

  /** 从持久化日志重建 todo 状态（重启后首次遇到该会话时）。 */
  async function restoreTodoState(sessionId) {
    let handle;
    try {
      // 0.2:SessionPersistence 不再提供 readFrom,改为打开一个只读句柄
      // 再读取其事件切片(句柄是单属主状态,读完必须 close 释放)。
      handle = await ctx.sessionPersistence.open(sessionId, 'read');
      const { events } = await handle.read(0);
      let last = null;
      for (const ev of events) {
        if (ev.type === 'todo/write') last = ev.data.todos;
      }
      if (last) {
        todoState.set(sessionId, last);
        return true;
      }
    } catch {
      // 读取失败视为暂无状态（日志缺失/损坏），不阻断后续
    } finally {
      try {
        await handle?.close();
      } catch {
        // 句柄关闭失败不影响功能
      }
    }
    return false;
  }

  async function handleTurnEnd(session, data) {
    if (!config.enabled) return;
    // 只处理正常完成；error（已有重试机制）与 aborted（用户主动中断）不触发
    if (data.reason?.kind !== 'completed') return;
    const sessionId = session.id;
    if (pauseMarks.has(sessionId)) {
      pauseMarks.delete(sessionId);
      return;
    }
    // 重启恢复：内存无该会话 todo 时从持久化日志重建
    if (!todoState.has(sessionId)) {
      await restoreTodoState(sessionId);
    }
    const open = pendingTodos(sessionId);
    // "无实质产出"：最后一条 assistant/message 存在，但没有非空白正文或工具调用。
    // 纯推理与空白正文都表示模型没有给用户可用结果；工具调用仍视为实质产出。
    const lastAssistant = lastAssistantState.get(sessionId);
    const stoppedAfterThinking = lastAssistant !== undefined && !lastAssistant.hasSubstantive;
    ctx.logger?.info(
      `[dsh-run-guard][continue] T${data.turn} open=${open.length} think-stop=${stoppedAfterThinking} lastState=${lastAssistant ? JSON.stringify(lastAssistant) : 'none'}`
    );
    debugLog(`continue:decide T${data.turn} open=${open.length} think-stop=${stoppedAfterThinking}`);

    if (open.length === 0) {
      // 无 todo：仅"想完就停"时自动继续（注入内容不含 todo 信息，无上限）
      if (!stoppedAfterThinking) return;
      ctx.logger?.info(`[dsh-run-guard][continue] followup(think-stop) T${data.turn}`);
      debugLog(`continue:followup think-stop T${data.turn}`);
      followupWith(sessionId, buildNoTodoFollowupText());
      return;
    }
    ctx.logger?.info(`[dsh-run-guard][continue] followup(todo) T${data.turn} count=${autoFollowupCount.get(sessionId) ?? 0}`);

    // 计数：本 turn 有实质产出 → 重置（模型在推进）；无产出 → 累计
    if (producedThisTurn.get(sessionId)) {
      autoFollowupCount.set(sessionId, 0);
    } else {
      const count = (autoFollowupCount.get(sessionId) ?? 0) + 1;
      autoFollowupCount.set(sessionId, count);
      if (count >= config.maxAutoFollowups) return; // 连续无产出达到上限，停止自动继续
    }
    // 标记期待恢复：下个 turn 的首条消息若是本插件注入，则补写 todo/write 恢复 UI 投影
    pendingRestore.add(sessionId);
    followupWith(sessionId, buildFollowupText(open));
  }

  /**
   * 自动继续的新 turn 里补写 todo/write，恢复官方投影（UI 计划条）。
   * 守卫：模型在本 turn 已写新列表（modelWrote）则跳过，不覆盖模型声明；
   * turn 已结束（flags 被清理）或会话已不可用同样跳过。
   */
  function scheduleRestore(sessionId) {
    setTimeout(() => {
      try {
        if (disposed) return;
        const flags = turnFlags.get(sessionId);
        if (!flags || flags.modelWrote) return;
        const todos = todoState.get(sessionId);
        if (!todos || todos.length === 0) return;
        const session = ctx.sessions.get(sessionId);
        if (!session) return;
        session.append('todo/write', { todos });
      } catch {
        // 恢复失败不影响后续 turn
      }
    }, 0);
  }

  // 状态跟踪 + turn 生命周期
  const removeSessionListener = ctx.on('session/event', (session, event) => {
    const t = event.type;
    if (t === 'todo/write') {
      todoState.set(session.id, event.data.todos);
      const flags = turnFlags.get(session.id);
      if (flags) flags.modelWrote = true;
    } else if (t === 'turn/start') {
      pauseMarks.delete(session.id); // 新 turn 重置暂停标记
      producedThisTurn.set(session.id, false);
      turnFlags.set(session.id, { firstMessage: false, modelWrote: false });
      lastAssistantState.delete(session.id); // 新 turn 重置"无实质产出"判定状态
    } else if (t === 'tool/call') {
      producedThisTurn.set(session.id, true); // 模型调用了工具 = 有产出
    } else if (t === 'assistant/message') {
      if (config.enabled) {
        ctx.logger?.info(`[dsh-run-guard][continue] assistant/message T${event.data.turn}/S${event.data.step}`);
        debugLog(`continue:assistant/message T${event.data.turn}/S${event.data.step}`);
      }
      // 实质产出 = 非空白正文或工具调用；纯推理/空白正文不算产出。
      const content = event.data?.message?.content;
      const hasSubstantive = hasSubstantiveContent(content);
      if (hasSubstantive) {
        producedThisTurn.set(session.id, true);
      }
      // 记录最后一条 assistant/message 的完整输出状态，不能只记录 block 类型：
      // { type: 'text', text: ' ' } 必须与真正正文区分开。
      if (Array.isArray(content)) {
        lastAssistantState.set(session.id, { hasSubstantive });
      }
    } else if (t === 'user/message') {
      // 首条消息判定：自动继续 turn（本插件注入）→ 消费标记并恢复 UI 投影；
      // 用户或其他注入开的新 turn → 放弃恢复（旧计划不强制激活）
      const flags = turnFlags.get(session.id);
      if (flags && !flags.firstMessage) {
        flags.firstMessage = true;
        if (pendingRestore.has(session.id)) {
          pendingRestore.delete(session.id);
          const source = event.data?.source;
          if (source?.kind === SOURCE_KIND) {
            scheduleRestore(session.id);
          }
        }
      }
      // 仅真实用户输入重置连续计数；插件注入（followup/system-prompt snapshot 等）
      // 不重置——否则自动继续消息会自我重置导致上限失效
      if (event.data?.source?.kind === 'user') {
        autoFollowupCount.set(session.id, 0);
      }
    } else if (t === 'turn/end') {
      turnFlags.delete(session.id);
      if (config.enabled) {
        ctx.logger?.info(`[dsh-run-guard][continue] turn/end T${event.data.turn} kind=${event.data.reason?.kind}`);
        debugLog(`continue:turn/end T${event.data.turn} kind=${event.data.reason?.kind}`);
      }
      void handleTurnEnd(session, event.data);
    }
  }, { global: true }); // session/event 是 scoped 事件,global 才能收到所有会话

  // 预防层：动态上下文注入（每轮组装求值，空文本不注入）。这个注册点
  // 必须挂在插件 fiber 的 effect 上，否则热重载会把旧定义留在全局 registry。
  const registerContext = () => ctx.systemPrompt.context({
    name: 'dsh-run-guard:todo-status',
    order: 200,
    text: (assembleCtx) => {
      if (!config.enabled) return '';
      const sessionId = assembleCtx.agent?.session.id;
      if (!sessionId) return '';
      const open = pendingTodos(sessionId);
      if (open.length === 0) return '';
      const { listed, more } = renderOpen(open);
      return [
        `当前有 ${open.length} 项未完成 todo：`,
        listed + more,
        '',
        '请继续执行，并【及时更新 todo 状态】——每完成一项就调用 todo_write 标记 completed；若确实需要暂停（等待用户输入、外部依赖、需要用户决策），调用 pause_work 工具。',
      ].join('\n');
    },
  });
  const disposeContext = typeof ctx.effect === 'function'
    ? ctx.effect(registerContext, 'dsh-run-guard: todo context')
    : registerContext();

  // pause_work：模型主动暂停标记
  const registerPauseTool = () => ctx.tools.register(defineTool({
    name: 'pause_work',
    description: '调用此工具表示你主动决定暂停当前任务（例如等待用户输入、外部依赖、需要用户决策、已交付阶段性成果）。调用后本 turn 结束时不会自动继续（无论有无未完成 todo、是否"想完就停"）。仅在确实需要暂停时调用；如果只是暂时停顿，请勿调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paused: { type: 'boolean', required: true },
        },
      },
      render: (_args, _value) => [{ type: 'text', text: '已标记主动暂停，本 turn 结束后不会自动继续。' }],
    },
    execute(_args, exec) {
      if (!exec.agent) throw new Error('pause_work requires an owning agent session');
      pauseMarks.add(exec.agent.session.id);
      return Promise.resolve({ paused: true });
    },
    presentCall: (args) => ({ card: 'generic', title: 'Pause work', kind: 'other', rawInput: args }),
  }));
  const disposeTool = typeof ctx.effect === 'function'
    ? ctx.effect(registerPauseTool, 'dsh-run-guard: pause tool')
    : registerPauseTool();

  return () => {
    disposed = true;
    removeSessionListener?.();
    disposeTool?.();
    disposeContext?.();
    todoState.clear();
    pauseMarks.clear();
    autoFollowupCount.clear();
    producedThisTurn.clear();
    turnFlags.clear();
    pendingRestore.clear();
    lastAssistantState.clear();
  };
}
