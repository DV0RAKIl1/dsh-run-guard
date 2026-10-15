/**
 * dsh-run-guard client half：在 Plugins 页面为 run-guard 行提供配置表单。
 *
 * 0.2.0-rc.2 起插件不再自注册 settings 命名空间，宿主也**不会**按 Config schema
 * 自动生成配置页（官方 `dsh-settings` 文档：`autoGenerate` 目前没有已发布的
 * 客户端消费）。配置入口必须由插件自己提供 client 组件，注册到 Plugins 页面
 * 声明的 `plugins.row.config` slot，key 为 `<包名>#<bundle patch 行 id>`；
 * 没有注册者的行不会显示任何配置控件。
 *
 * 表单直接消费宿主下发的配置能力 `ctx.configForms.get('run-guard')`：
 * 读 schema 解析后的 section（含默认值），并以 path 操作一次性写回 profile
 * patch。因此不再需要插件自建 HTTP 路由，也不再需要 webServer 服务。
 *
 * 手写的 client-bundle 格式，由 `window.__ModuleLoader__.load` 消费，
 * 与官方设置卡片一致。
 * @module dsh-run-guard/client
 */
window.__ModuleLoader__.load({
  id: "dsh-run-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { SettingsForm, SettingsValueField, Switch } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;

    /** profile 里的插件条目 id，同时也是 bundle patch 里的行 id。 */
    const NS = "run-guard";
    /** `plugins.row.config` 的 key：`<包名>#<行 id>`。 */
    const ROW_KEY = "dsh-run-guard#run-guard";

    /** Client services required before activation. */
    const inject = ["slots", "configForms"];

    /** 页面文案（与插件其余部分一致，直接用中文）。 */
    const TEXT = {
      summary: "推理死循环拦截 + 提前停摆自动继续",
      save: "保存",
      saving: "保存中…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      readOnly: "本部署的设置为只读。",
      unavailable: "该插件当前未加载，暂时无法配置。",
      overridden: "已覆盖",
      reset: "恢复默认",
      invalidNumber: "请填数字；留空表示使用默认值。",
    };

    /**
     * 字段表：与 lib/index.js 的 Config schema 一一对应。
     * `kind` 决定控件与草稿的转换方式，`path` 是 section 内的路径。
     */
    const FIELDS = [
      { group: "通用", path: ["enabled"], kind: "boolean", label: "启用插件", hint: "总开关，关闭后两个能力都不生效" },
      { group: "Guard · 死循环拦截", path: ["guard", "enabled"], kind: "boolean", label: "死循环拦截", hint: "检测推理流中的重复空转并中断" },
      { group: "Guard · 死循环拦截", path: ["guard", "windowChars"], kind: "number", label: "滑动窗口（字符）", hint: "重复率检测的窗口大小" },
      { group: "Guard · 死循环拦截", path: ["guard", "substrLen"], kind: "number", label: "重复检测子串长度", hint: "窗口内切片比较的粒度" },
      { group: "Guard · 死循环拦截", path: ["guard", "repeatRatio"], kind: "number", label: "窗口重复率阈值", hint: "重复占比 ≥ 该值触发中断（0.7 = 70%）" },
      { group: "Guard · 死循环拦截", path: ["guard", "checkEvery"], kind: "number", label: "检测频率（每 N 块）", hint: "每 N 个推理块做一次检测，越大越省开销" },
      { group: "Guard · 死循环拦截", path: ["guard", "maxBlocks"], kind: "number", label: "硬闸：推理块数上限", hint: "单次调用推理块数超过即中断" },
      { group: "Guard · 死循环拦截", path: ["guard", "maxChars"], kind: "number", label: "硬闸：推理字符数上限", hint: "单次推理字符数超过即中断" },
      { group: "Guard · 死循环拦截", path: ["guard", "maxGuardRetries"], kind: "number", label: "中断后自动重试上限", hint: "每个 turn 最多自动重试次数，0 表示不重试" },
      { group: "Guard · 死循环拦截", path: ["guard", "autoRetryErrors"], kind: "csv", label: "额外重试错误码", hint: "逗号分隔；这些错误码也自动重试（REASONING_GUARD 恒重试）" },
      { group: "Continue · 自动继续", path: ["continue", "enabled"], kind: "boolean", label: "自动继续", hint: "turn 结束后按需自动续跑" },
      { group: "Continue · 自动继续", path: ["continue", "maxAutoFollowups"], kind: "number", label: "有 todo 续跑上限", hint: "有未完成 todo 时，连续无产出续跑的上限" },
    ];

    /** 读取 section 内的路径值。 */
    function getPath(obj, path) {
      let cur = obj;
      for (const key of path) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = cur[key];
      }
      return cur;
    }

    /** 该路径是否在 user 层里被显式覆盖（存在性即覆盖，不比数值）。 */
    function hasPath(obj, path) {
      let cur = obj;
      for (const key of path) {
        if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return false;
        cur = cur[key];
      }
      return true;
    }

    /** 存储值 → 草稿文本。 */
    function formatValue(field, value) {
      if (value === undefined || value === null) return "";
      if (field.kind === "csv") return Array.isArray(value) ? value.join(", ") : String(value);
      return String(value);
    }

    /**
     * 草稿文本 → 一次写入。
     * @returns `{kind:'set',value}`、`{kind:'clear'}`，或 undefined 表示该文本不是本字段接受的值。
     */
    function parseText(field, text) {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      if (field.kind === "csv") {
        return { kind: "set", value: trimmed.split(",").map((s) => s.trim()).filter(Boolean) };
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num)) return undefined;
      return { kind: "set", value: num };
    }

    /** 订阅宿主配置快照。 */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      React.useEffect(() => {
        setSnapshot(form.getSnapshot());
        return form.subscribe(() => setSnapshot(form.getSnapshot()));
      }, [form]);
      return snapshot;
    }

    /** 一组字段的小标题 + 行。 */
    function Group({ name, children }) {
      return h("section", { style: { marginBottom: 18 } },
        h("div", {
          style: {
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--dsw-alias-label-tertiary)",
            marginBottom: 4,
          },
        }, name),
        children);
    }

    /** 布尔行：label + hint 在左，开关在右。 */
    function BooleanRow({ field, checked, disabled, onToggle }) {
      return h("div", {
        style: { display: "flex", alignItems: "center", gap: 12, padding: "9px 0" },
      },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 13, lineHeight: 1.4 } }, field.label),
          h("div", { style: { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)", marginTop: 1, lineHeight: 1.45 } }, field.hint)),
        h(Switch, { checked, onChange: onToggle, label: field.label, disabled }));
    }

    /** 配置卡片：Plugins 页面在 `view: 'page'` 时渲染它。 */
    function ConfigCard(props) {
      const form = props.configForm;
      const snapshot = useFormSnapshot(form);
      /** key -> `{kind:'text',text}` | `{kind:'value',value}` | `{kind:'clear'}` */
      const [drafts, setDrafts] = React.useState(() => new Map());
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      if (props.view === "summary") return TEXT.summary;

      const disabled = !snapshot.writable;
      const base = snapshot.base;

      const stage = (key, draft) => {
        setFailed(false);
        setDrafts((prev) => {
          const next = new Map(prev);
          next.set(key, draft);
          return next;
        });
      };

      /** 一个字段当前的展示态。 */
      const viewOf = (field) => {
        const key = field.path.join(".");
        const draft = drafts.get(key);
        const stored = getPath(snapshot.value, field.path);
        const overridden = snapshot.user !== null && snapshot.user !== undefined && hasPath(snapshot.user, field.path);
        if (field.kind === "boolean") {
          const checked = draft === undefined
            ? stored === true
            : draft.kind === "clear" ? false : draft.value === true;
          return { key, checked, overridden: draft === undefined ? overridden : draft.kind !== "clear", invalid: false };
        }
        if (draft === undefined) {
          return { key, text: formatValue(field, stored), overridden, invalid: false };
        }
        if (draft.kind === "clear") {
          return { key, text: formatValue(field, getPath(base, field.path)), overridden: false, invalid: false };
        }
        const parsed = parseText(field, draft.text);
        return { key, text: draft.text, overridden: parsed !== undefined && parsed.kind === "set", invalid: parsed === undefined };
      };

      const views = FIELDS.map(viewOf);
      const invalid = views.some((v) => v.invalid);

      const save = async () => {
        const ops = [];
        for (const field of FIELDS) {
          const draft = drafts.get(field.path.join("."));
          if (draft === undefined) continue;
          if (field.kind === "boolean") {
            if (draft.kind === "clear") ops.push({ op: "unset", path: field.path });
            else ops.push({ op: "set", path: field.path, value: draft.value === true });
            continue;
          }
          if (draft.kind === "clear") {
            ops.push({ op: "unset", path: field.path });
            continue;
          }
          const parsed = parseText(field, draft.text);
          if (parsed === undefined) return;
          if (parsed.kind === "clear") ops.push({ op: "unset", path: field.path });
          else ops.push({ op: "set", path: field.path, value: parsed.value });
        }
        if (ops.length === 0) return;
        setSaving(true);
        setFailed(false);
        try {
          const landed = await form.mutate(ops, snapshot.revision);
          if (landed) setDrafts(new Map());
          setFailed(!landed);
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        setDrafts(new Map());
        setFailed(false);
      };

      const groups = [];
      for (const field of FIELDS) {
        const existing = groups.find((g) => g.name === field.group);
        if (existing) existing.fields.push(field);
        else groups.push({ name: field.group, fields: [field] });
      }

      const children = groups.map((group) => h(Group, { key: group.name, name: group.name },
        group.fields.map((field) => {
          const v = viewOf(field);
          if (field.kind === "boolean") {
            return h(BooleanRow, {
              key: v.key,
              field,
              checked: v.checked,
              disabled,
              onToggle: (next) => stage(v.key, { kind: "value", value: next }),
            });
          }
          return h(SettingsValueField, {
            key: v.key,
            id: `run-guard-${v.key.replace(/\./g, "-")}`,
            label: field.label,
            hint: field.hint,
            text: v.text,
            overridden: v.overridden,
            invalid: v.invalid,
            overriddenLabel: TEXT.overridden,
            resetLabel: TEXT.reset,
            invalidLabel: TEXT.invalidNumber,
            numeric: field.kind === "number",
            disabled,
            onEdit: (text) => stage(v.key, { kind: "text", text }),
            onReset: () => stage(v.key, { kind: "clear" }),
          });
        })));

      return h(SettingsForm, {
        labels: {
          unavailable: TEXT.unavailable,
          readOnly: TEXT.readOnly,
          saveFailed: TEXT.saveFailed,
          save: TEXT.save,
          saving: TEXT.saving,
        },
        state: {
          available: snapshot.status === "ready",
          writable: snapshot.writable,
          dirty: drafts.size > 0,
          invalid,
          saving,
          failed,
        },
        onSave: save,
        onDiscard: discard,
      }, children);
    }

    /** Client plugin body. */
    function apply(ctx) {
      const form = ctx.configForms.get(NS);
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
        name: "plugins.row.config",
        key: ROW_KEY,
      }, (props) => h(ConfigCard, { view: props.view, configForm: form })))), "dsh-run-guard:config-card");
    }

    exports.apply = apply;
    exports.inject = inject;
    /** 字段表,供单测断言它与 Host 的 Config schema 保持一致。 */
    exports.__fields = FIELDS;
    return module.exports;
  },
});
