/**
 * 插件配置读取。
 *
 * 0.2.0-rc.2 起插件配置不再由插件自注册 settings 命名空间,而是由 Cordis
 * Loader 按插件导出的 `Config` schema 解析 profile patch 里的插件条目。标记
 * `.volatile()` 的字段被解析成 `Volatile` 句柄(设置界面可 live 编辑,取值要
 * 走 `.get()`),未标记的字段就是普通值。这里统一解包,让调用方不必关心某个
 * 字段是不是 volatile。
 *
 * @module dsh-run-guard/config
 */

/**
 * 判断一个值是否是 `Volatile` 句柄(鸭子类型,避免直接依赖 cosmokit)。
 * @param {unknown} value - 待判断的值。
 * @returns {boolean} 是否形如 Volatile 句柄。
 */
export function isVolatile(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (/** @type {{ get?: unknown }} */ (value).get) === 'function'
  );
}

/**
 * 解包一个可能是 `Volatile` 句柄的配置字段。
 * @param {unknown} value - 原始字段值(Volatile 句柄、普通值或 undefined)。
 * @param {unknown} fallback - 字段缺失(undefined)时使用的默认值。
 * @returns {unknown} 解包后的普通值;字段显式存在但为 null 时保留 null。
 */
export function readConfig(value, fallback) {
  if (isVolatile(value)) {
    const raw = /** @type {{ get: () => unknown }} */ (value).get();
    return raw === undefined ? fallback : raw;
  }
  return value === undefined ? fallback : value;
}
