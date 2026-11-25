/** 小心地创建 DOM，不用 innerHTML 拼用户数据。 */

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function field(label, control, hint, errorNode) {
  return h(
    'div',
    { class: 'field' },
    h('label', { for: control.id }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
    errorNode ?? null,
  );
}

/** 毫秒 → "1.4 s" / "820 ms"，扫描耗时用。 */
export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatClock(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-TW', { hour12: false });
}

/** Toast：默认 4 秒后自动消失，点一下就关。 */
const TOASTS = { ok: 3500, error: 6500, info: 4000 };

export function toast(message, kind = 'info') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const node = h('div', { class: 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  node.addEventListener('click', () => node.remove());
  stack.append(node);
  const ttl = TOASTS[kind] ?? 4000;
  setTimeout(() => node.remove(), ttl);
}
