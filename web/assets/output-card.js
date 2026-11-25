/**
 * 面板底部那张「Agent 看到的内容」卡片。
 *
 * 这是本项目的核心验证点：同一份命令核心，Agent 拿到的是 render() 的纯文本，
 * 面板拿到的是同一段文本 + structured。把这段文本显示出来，人和 Agent 看到的就是同一件事。
 */
import { h, clear, formatDuration, toast } from './dom.js';

/**
 * @param {{ title?: string, hint?: string }} [options]
 */
export function createOutputCard(options = {}) {
  const body = h('pre', { class: 'agent-body', tabindex: '0' }, '尚未呼叫任何命令。');
  const meta = h('span', { class: 'agent-meta' }, '');
  const copyButton = h(
    'button',
    { class: 'btn btn-sm btn-ghost', type: 'button', title: '複製 Agent 端純文本' },
    '複製',
  );

  copyButton.addEventListener('click', async () => {
    const text = body.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      toast('已複製到剪貼簿', 'ok');
    } catch {
      toast('瀏覽器拒絕存取剪貼簿', 'error');
    }
  });

  const card = h(
    'section',
    { class: 'card agent-card' },
    h(
      'header',
      { class: 'card-head' },
      h('h2', {}, options.title ?? 'Agent 收到什麼'),
      h('span', { class: 'card-head-spacer' }),
      meta,
      copyButton,
    ),
    h(
      'div',
      { class: 'card-body agent-body-wrap' },
      options.hint ? h('p', { class: 'agent-hint' }, options.hint) : null,
      body,
    ),
  );

  return {
    element: card,
    /**
     * @param {string} text  命令 render() 的输出
     * @param {number} [elapsedMs]
     * @param {'ok'|'error'} [kind]
     */
    show(text, elapsedMs, kind = 'ok') {
      body.textContent = text;
      body.dataset.kind = kind;
      meta.textContent = elapsedMs === undefined ? kind : `${kind} · ${formatDuration(elapsedMs)}`;
      meta.dataset.kind = kind;
    },
    clear() {
      body.textContent = '尚未呼叫任何命令。';
      body.dataset.kind = '';
      meta.textContent = '';
      clear(meta);
    },
  };
}
