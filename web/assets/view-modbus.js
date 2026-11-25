/**
 * modbus 面板。
 *
 * 与 netscan 同一个原则：面板是命令的「图形外壳」，不是另一套实现。
 *   - 所有动作都通过 invokeCommand() 打到同一份命令处理器
 *   - 表单值只是命令 input 的可视化编辑，不做第二套校验
 *   - 轮询直接重复呼叫 modbus_read，参数与 Agent 完全一致
 *
 * 唯一一个 Agent 拿不到的命令是 modbus_set_guard：唯读锁定必须由人开关。
 * 面板把它画成一个开关，Agent 端根本看不到这个名字（core 的 expose 过滤）。
 */
import { invokeCommand, ApiError } from './api.js';
import { h, clear, field, formatDuration, formatClock, toast } from './dom.js';
import { createOutputCard } from './output-card.js';

const STORE_KEY = 'mcps.modbus.form/v1';
const KINDS = [
  { id: 'holding', label: '保持暫存器', hint: 'FC03' },
  { id: 'input', label: '輸入暫存器', hint: 'FC04' },
  { id: 'coil', label: '線圈', hint: 'FC01' },
  { id: 'discrete', label: '離散輸入', hint: 'FC02' },
];
const TYPES = ['u16', 'i16', 'u32', 'i32', 'f32'];
const WORD_ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'];

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function hex4(value) {
  return `0x${(Number(value) & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

function select(options, value, id) {
  const node = h('select', { class: 'input', id: id ?? '' });
  for (const option of options) {
    const entry = typeof option === 'string' ? { id: option, label: option } : option;
    const item = h('option', { value: entry.id }, entry.label + (entry.hint ? `（${entry.hint}）` : ''));
    if (entry.id === value) item.selected = true;
    node.append(item);
  }
  return node;
}

export function createModbusView({ setStatus }) {
  const saved = readSaved();
  const state = {
    connected: false,
    readOnly: false,
    recentWrites: [],
    kind: saved.kind ?? 'holding',
    type: saved.type ?? 'u16',
    wordOrder: saved.wordOrder ?? 'ABCD',
    polling: false,
    pollTimer: null,
    rows: null,
  };

  // ---- 连线
  const hostInput = h('input', { class: 'input', id: 'mb-host', placeholder: '192.168.0.10', autocomplete: 'off', spellcheck: 'false' });
  const portInput = h('input', { class: 'input', id: 'mb-port', type: 'number', min: '1', max: '65535', value: String(saved.port ?? 502) });
  const unitInput = h('input', { class: 'input', id: 'mb-unit', type: 'number', min: '0', max: '255', value: String(saved.unitId ?? 1) });
  const timeoutInput = h('input', { class: 'input', id: 'mb-timeout', type: 'number', min: '100', max: '60000', step: '100', value: String(saved.timeoutMs ?? 3000) });
  hostInput.value = saved.host ?? '';

  const connectButton = h('button', { class: 'btn btn-primary', type: 'submit' }, '連線');
  const disconnectButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '中斷');
  const connectState = h('span', { class: 'result-target empty' }, '未連線');
  const guardInput = h('input', { type: 'checkbox' });
  const guardHint = h('span', { class: 'field-hint' }, '開啟後面板與 Agent 都無法寫入。只有這裡能解鎖。');
  const banner = h('div', { class: 'banner banner-error', hidden: '' });

  const connectionForm = h(
    'form',
    { class: 'card-body', novalidate: '' },
    banner,
    h(
      'div',
      { class: 'grid-form' },
      field('位址', hostInput, '設備 IP 或主機名'),
      field('埠號', portInput, 'Modbus TCP 通常是 502'),
      field('站號', unitInput, '0 – 255，切換站號不必重連'),
      field('請求逾時 (ms)', timeoutInput, '100 – 60000，現場設備慢就調大'),
      h(
        'div',
        { class: 'field span-2' },
        h('label', {}, '唯讀鎖定'),
        h('label', { class: 'switch' }, guardInput, h('span', {}, '擋下所有寫入（含 Agent）')),
        guardHint,
      ),
    ),
    h('div', { class: 'form-actions' }, connectButton, disconnectButton, h('span', { class: 'form-actions-spacer' }), connectState),
  );

  // ---- 读取
  const kindSelect = select(KINDS, state.kind, 'mb-kind');
  const typeSelect = select(TYPES, state.type, 'mb-type');
  const orderSelect = select(WORD_ORDERS, state.wordOrder, 'mb-order');
  const startInput = h('input', { class: 'input', id: 'mb-start', type: 'number', min: '0', max: '65535', value: String(saved.start ?? 0) });
  const countInput = h('input', { class: 'input', id: 'mb-count', type: 'number', min: '1', max: '2048', value: String(saved.count ?? 16) });
  const scaleInput = h('input', { class: 'input', id: 'mb-scale', type: 'number', step: 'any', value: String(saved.scale ?? 1) });
  const offsetInput = h('input', { class: 'input', id: 'mb-offset', type: 'number', step: 'any', value: String(saved.offset ?? 0) });
  const readButton = h('button', { class: 'btn btn-primary', type: 'submit' }, '讀取');
  const pollInput = h('input', { type: 'checkbox', checked: saved.polling === true });
  const pollIntervalInput = h('input', { class: 'input', id: 'mb-poll-ms', type: 'number', min: '200', max: '10000', step: '100', value: String(saved.pollIntervalMs ?? 1000) });
  const readState = h('span', { class: 'result-target empty' }, '尚未讀取');

  const readForm = h(
    'form',
    { class: 'card-body', novalidate: '' },
    h(
      'div',
      { class: 'grid-form' },
      field('資料表', kindSelect, '保持／輸入暫存器是 16 位；線圈／離散輸入是位元'),
      field('起始位址', startInput, '0 – 65535'),
      field('數量', countInput, '暫存器最多 1024，位元最多 2048（自動切塊）'),
      field('型別', typeSelect, '32 位型別佔兩個暫存器'),
      field('字序', orderSelect, '32 位值的四種排列'),
      field('工程比例', scaleInput, '例如 0.1：暫存器 235 顯示 23.5'),
      field('位移', offsetInput, '套用順序：值 × scale + offset'),
      h(
        'div',
        { class: 'field' },
        h('label', {}, '輪詢'),
        h('label', { class: 'switch' }, pollInput, h('span', {}, '持續讀取同一段位址')),
        pollIntervalInput,
        h('span', { class: 'field-hint' }, '間隔 200 – 10000 ms；慢設備請調大，避免堆積'),
      ),
    ),
    h('div', { class: 'form-actions' }, readButton, h('span', { class: 'form-actions-spacer' }), readState),
  );

  // ---- 写入
  const writeKindSelect = select(KINDS.slice(0, 3), saved.writeKind ?? 'holding', 'mb-write-kind');
  const writeAddressInput = h('input', { class: 'input', id: 'mb-write-address', type: 'number', min: '0', max: '65535', value: String(saved.writeAddress ?? 0) });
  const writeValueInput = h('input', { class: 'input', id: 'mb-write-value', type: 'number', step: 'any', value: saved.writeValue ?? '' });
  const writeBitInput = h('input', { class: 'input', id: 'mb-write-bit', type: 'number', min: '0', max: '15', value: saved.writeBit ?? '' });
  const writeValuesInput = h('input', { class: 'input', id: 'mb-write-values', placeholder: '1,2,3', autocomplete: 'off' });
  const verifyInput = h('input', { type: 'checkbox', checked: saved.verify === true });
  const writeButton = h('button', { class: 'btn btn-primary', type: 'submit' }, '寫入');
  const watchButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '寫後確認');
  const writeState = h('span', { class: 'result-target empty' }, '尚未寫入');

  const writeForm = h(
    'form',
    { class: 'card-body', novalidate: '' },
    h(
      'div',
      { class: 'grid-form' },
      field('資料表', writeKindSelect, '離散輸入永遠唯讀，所以不在這裡'),
      field('位址', writeAddressInput, '0 – 65535'),
      field('單筆值', writeValueInput, '32 位型別填工程值即可，會自動拆成兩筆暫存器'),
      field('位元 (0-15)', writeBitInput, '填了位元就只改這一個 bit，其餘保留'),
      field('批次值', writeValuesInput, '逗號分隔的原始字組，例如 1,2,3'),
      h(
        'div',
        { class: 'field' },
        h('label', {}, '讀回驗證'),
        h('label', { class: 'switch' }, verifyInput, h('span', {}, '寫入後讀回比對')),
        h('span', { class: 'field-hint' }, '不等於寫入值時會標示 NOT verified'),
      ),
    ),
    h('div', { class: 'form-actions' }, writeButton, watchButton, h('span', { class: 'form-actions-spacer' }), writeState),
  );

  // ---- 结果
  const resultBody = h('div', { class: 'card-body result-body' });
  const liveTag = h('span', { class: 'live-tag', hidden: '' }, '輪詢中');
  const resultCard = h(
    'section',
    { class: 'card', hidden: '' },
    h('header', { class: 'card-head' }, h('h2', {}, '讀取結果'), h('span', { class: 'card-head-spacer' }), liveTag),
    resultBody,
  );

  const writesBody = h('div', { class: 'card-body' });
  const writesCard = h(
    'section',
    { class: 'card', hidden: '' },
    h('header', { class: 'card-head' }, h('h2', {}, '最近的寫入'), h('span', { class: 'card-head-spacer' })),
    writesBody,
  );

  const outputCard = createOutputCard({
    hint: '下面這段就是 Agent 端 render() 收到的純文本 —— 面板與 Agent 共用同一個處理器。',
  });

  const root = h(
    'div',
    { class: 'view' },
    h('section', { class: 'card' }, h('header', { class: 'card-head' }, h('h2', {}, '連線')), connectionForm),
    h('section', { class: 'card' }, h('header', { class: 'card-head' }, h('h2', {}, '讀取')), readForm),
    h('section', { class: 'card' }, h('header', { class: 'card-head' }, h('h2', {}, '寫入')), writeForm),
    resultCard,
    writesCard,
    outputCard.element,
  );

  // ---- 持久化
  function persist() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          host: hostInput.value.trim(),
          port: Number(portInput.value),
          unitId: Number(unitInput.value),
          timeoutMs: Number(timeoutInput.value),
          kind: kindSelect.value,
          type: typeSelect.value,
          wordOrder: orderSelect.value,
          start: Number(startInput.value),
          count: Number(countInput.value),
          scale: Number(scaleInput.value),
          offset: Number(offsetInput.value),
          polling: pollInput.checked,
          pollIntervalMs: Number(pollIntervalInput.value),
          writeKind: writeKindSelect.value,
          writeAddress: Number(writeAddressInput.value),
          writeValue: writeValueInput.value === '' ? '' : Number(writeValueInput.value),
          writeBit: writeBitInput.value === '' ? '' : Number(writeBitInput.value),
          verify: verifyInput.checked,
        }),
      );
    } catch {
      /* 私密模式可能拒绝写入，不影响操作 */
    }
  }

  function showBanner(message) {
    banner.textContent = message;
    banner.hidden = false;
  }

  function clearBanner() {
    banner.textContent = '';
    banner.hidden = true;
  }

  function reportError(error, target, card) {
    const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
    if (target) {
      target.textContent = '失敗';
      target.className = 'result-target';
    }
    if (card) card.show(`[${error?.code ?? 'error'}] ${message}`, undefined, 'error');
    setStatus('error', message);
    toast(message, 'error');
  }

  /** 连线状态：勾选开关、显示位址、列出最近写入。 */
  function applySnapshot(snapshot) {
    state.connected = snapshot.connected === true;
    state.readOnly = snapshot.readOnly === true;
    state.recentWrites = snapshot.recentWrites ?? [];
    guardInput.checked = state.readOnly;
    connectState.textContent = state.connected
      ? `${snapshot.host}:${snapshot.port} · 站號 ${snapshot.unitId}`
      : snapshot.lastError
        ? `未連線（上次錯誤：${snapshot.lastError}）`
        : '未連線';
    connectState.className = state.connected ? 'result-target' : 'result-target empty';

    if (state.recentWrites.length === 0) {
      writesCard.hidden = true;
      return;
    }
    writesCard.hidden = false;
    clear(writesBody);
    const table = h(
      'table',
      { class: 'result' },
      h('thead', {}, h('tr', {}, h('th', {}, '時間'), h('th', {}, '來源'), h('th', {}, '資料表'), h('th', {}, '位址'), h('th', {}, '值'))),
    );
    const body = h('tbody');
    for (const entry of state.recentWrites) {
      const value = entry.bit !== undefined ? `bit ${entry.bit} = ${entry.value}` : Array.isArray(entry.values) ? entry.values.join(',') : String(entry.value ?? '');
      body.append(
        h(
          'tr',
          {},
          h('td', {}, formatClock(entry.at)),
          h('td', {}, entry.source === 'tool' ? 'Agent' : '面板'),
          h('td', {}, entry.kind),
          h('td', {}, String(entry.address)),
          h('td', {}, value),
        ),
      );
    }
    table.append(body);
    writesBody.append(h('div', { class: 'table-wrap' }, table));
  }

  async function refreshConnection() {
    try {
      const { result, text } = await invokeCommand('modbus_connection', {});
      applySnapshot(result);
      outputCard.show(text);
      setStatus(state.connected ? 'idle' : 'idle', state.connected ? `已連線 ${result.host}:${result.port}` : '未連線');
    } catch (error) {
      reportError(error);
    }
  }

  async function connect() {
    const host = hostInput.value.trim();
    if (host === '') {
      showBanner('請先填位址');
      hostInput.focus();
      return;
    }
    clearBanner();
    setStatus('busy', '連線中…');
    try {
      const { result, text } = await invokeCommand('modbus_connection', {
        action: 'connect',
        host,
        port: Number(portInput.value),
        unitId: Number(unitInput.value),
        timeoutMs: Number(timeoutInput.value),
      });
      applySnapshot(result);
      outputCard.show(text);
      setStatus('idle', `已連線 ${result.host}:${result.port} 站號 ${result.unitId}`);
      persist();
    } catch (error) {
      reportError(error);
    }
  }

  async function disconnect() {
    stopPolling();
    try {
      const { result, text } = await invokeCommand('modbus_connection', { action: 'disconnect' });
      applySnapshot(result);
      outputCard.show(text);
      setStatus('idle', '已中斷連線');
    } catch (error) {
      reportError(error);
    }
  }

  function readInput() {
    return {
      ...(kindSelect.value ? { kind: kindSelect.value } : {}),
      start: Number(startInput.value),
      count: Number(countInput.value),
      ...(kindSelect.value === 'coil' || kindSelect.value === 'discrete'
        ? {}
        : {
            type: typeSelect.value,
            wordOrder: orderSelect.value,
            scale: Number(scaleInput.value === '' ? 1 : scaleInput.value),
            offset: Number(offsetInput.value === '' ? 0 : offsetInput.value),
          }),
    };
  }

  /** 读一次并重画；轮询与手动读取走同一条路。 */
  async function read({ silent = false } = {}) {
    if (!silent) setStatus('busy', '讀取中…');
    try {
      const began = Date.now();
      const { result, text } = await invokeCommand('modbus_read', readInput());
      state.rows = result;
      renderResult(result);
      outputCard.show(text, Date.now() - began);
      readState.textContent = `${result.chunks} 次請求 · ${formatDuration(result.latencyMs)}`;
      readState.className = 'result-target';
      setStatus('idle', `讀到 ${Array.isArray(result.bits) ? result.bits.length : (result.rows ?? []).length} 個值`);
      persist();
      return result;
    } catch (error) {
      stopPolling();
      reportError(error, readState, outputCard);
      return null;
    }
  }

  function renderResult(result) {
    resultCard.hidden = false;
    clear(resultBody);
    const bits = Array.isArray(result.bits);
    if (bits) {
      const cells = [];
      result.bits.forEach((on, index) => {
        const address = result.start + index;
        const cell = h(
          'button',
          {
            class: 'chip',
            type: 'button',
            'data-active': String(on),
            title: `${address} = ${on ? 1 : 0}（點一下切換）`,
          },
          String(address),
        );
        cell.addEventListener('click', async () => {
          try {
            const { result: written, text } = await invokeCommand('modbus_write', {
              kind: kindSelect.value,
              address,
              value: on ? 0 : 1,
            });
            outputCard.show(text);
            writeState.textContent = `位元 ${written.address} → ${written.value}`;
            writeState.className = 'result-target';
            await read({ silent: true });
          } catch (error) {
            reportError(error, writeState, outputCard);
          }
        });
        cells.push(cell);
      });
      resultBody.append(
        h('div', { class: 'chip-row' }, ...cells),
        h('p', { class: 'field-hint' }, `${result.count} 個位元 · ${result.chunks} 次請求 · ${result.latencyMs} ms`),
      );
      return;
    }

    if (result.trailing > 0) {
      resultBody.append(
        h('div', { class: 'banner banner-warn' }, `尾端有 ${result.trailing} 個暫存器湊不成一個 ${result.type} 值，請調整數量。`),
      );
    }
    if (result.truncated) {
      resultBody.append(
        h('div', { class: 'banner banner-warn' }, `要求 ${result.requested} 筆，超過單次上限，只讀了 ${result.count} 筆。`),
      );
    }
    const head = h('tr', {}, h('th', {}, '位址'), h('th', {}, '原始字組'), h('th', {}, '值'));
    const body = h('tbody');
    for (const row of result.rows ?? []) {
      body.append(
        h(
          'tr',
          {},
          h('td', {}, String(row.address)),
          h('td', {}, row.raw.map(hex4).join(' ')),
          h('td', {}, row.text),
        ),
      );
    }
    resultBody.append(
      h('div', { class: 'table-wrap' }, h('table', { class: 'result' }, h('thead', {}, head), body)),
      h(
        'p',
        { class: 'field-hint' },
        `${result.rows?.length ?? 0} 個值 · ${result.type} / ${result.wordOrder} · scale ${result.scale} offset ${result.offset} · ${result.chunks} 次請求 · ${result.latencyMs} ms${result.reconnected ? ' · 已自動重連' : ''}`,
      ),
    );
  }

  function startPolling() {
    const intervalMs = Math.max(200, Number(pollIntervalInput.value) || 1000);
    state.polling = true;
    liveTag.hidden = false;
    const tick = async () => {
      if (!state.polling) return;
      await read({ silent: true });
      if (state.polling) state.pollTimer = setTimeout(tick, intervalMs);
    };
    void tick();
    persist();
  }

  function stopPolling() {
    state.polling = false;
    liveTag.hidden = true;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    pollInput.checked = false;
  }

  function parseValues(text) {
    return text
      .split(/[,\s]+/)
      .filter((part) => part !== '')
      .map((part) => Number(part));
  }

  async function write({ thenWatch = false } = {}) {
    const body = {
      kind: writeKindSelect.value,
      address: Number(writeAddressInput.value),
    };
    const batch = parseValues(writeValuesInput.value);
    const bit = writeBitInput.value === '' ? null : Number(writeBitInput.value);
    if (batch.length > 0) body.values = batch;
    else if (bit !== null) {
      body.bit = bit;
      body.value = Number(writeValueInput.value || 0);
    } else if (writeValueInput.value !== '') {
      body.value = Number(writeValueInput.value);
      if (writeKindSelect.value === 'holding') {
        body.type = typeSelect.value;
        body.wordOrder = orderSelect.value;
        body.scale = Number(scaleInput.value === '' ? 1 : scaleInput.value);
        body.offset = Number(offsetInput.value === '' ? 0 : offsetInput.value);
      }
    } else {
      toast('請填單筆值、批次值或位元', 'error');
      writeValueInput.focus();
      return;
    }
    if (verifyInput.checked) body.verify = true;

    setStatus('busy', '寫入中…');
    try {
      const { result, text } = await invokeCommand('modbus_write', body);
      outputCard.show(text);
      writeState.textContent = result.verified === false ? '寫入但驗證不符' : `已寫入 ${result.address}`;
      writeState.className = result.verified === false ? 'result-target empty' : 'result-target';
      setStatus(result.verified === false ? 'error' : 'idle', text.split('\n')[0]);
      persist();
      if (thenWatch) {
        const expect = Number(writeValueInput.value);
        if (Number.isFinite(expect)) {
          const watched = await invokeCommand('modbus_watch', {
            ...readInput(),
            start: Number(writeAddressInput.value),
            expect,
            timeoutMs: 3000,
          });
          outputCard.show(watched.text);
          setStatus('idle', watched.text.split('\n')[0]);
        }
      }
      await refreshConnection();
    } catch (error) {
      reportError(error, writeState, outputCard);
    }
  }

  async function toggleGuard() {
    try {
      const { text } = await invokeCommand('modbus_set_guard', { readOnly: guardInput.checked });
      outputCard.show(text);
      await refreshConnection();
      toast(guardInput.checked ? '唯讀鎖定已開啟' : '唯讀鎖定已關閉', 'ok');
    } catch (error) {
      guardInput.checked = state.readOnly;
      reportError(error);
    }
  }

  connectionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void connect();
  });
  disconnectButton.addEventListener('click', () => void disconnect());
  guardInput.addEventListener('change', () => void toggleGuard());

  readForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void read();
  });
  pollInput.addEventListener('change', () => {
    if (pollInput.checked) startPolling();
    else stopPolling();
  });
  kindSelect.addEventListener('change', () => {
    const bits = kindSelect.value === 'coil' || kindSelect.value === 'discrete';
    typeSelect.disabled = bits;
    orderSelect.disabled = bits;
    scaleInput.disabled = bits;
    offsetInput.disabled = bits;
  });

  writeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void write();
  });
  watchButton.addEventListener('click', () => void write({ thenWatch: true }));

  return {
    element: root,
    async mount() {
      kindSelect.dispatchEvent(new Event('change'));
      await refreshConnection();
      if (state.connected) await read({ silent: true });
      if (pollInput.checked) startPolling();
    },
    unmount() {
      stopPolling();
    },
  };
}
