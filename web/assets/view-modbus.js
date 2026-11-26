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
    profiles: Array.isArray(saved.profiles) ? saved.profiles : [],
    activeProfile: saved.activeProfile ?? '',
    pollFailures: 0,
  };

  // ---- 连线
  const hostInput = h('input', { class: 'input', id: 'mb-host', placeholder: '127.0.0.1', autocomplete: 'off', spellcheck: 'false' });
  const portInput = h('input', { class: 'input', id: 'mb-port', type: 'number', min: '1', max: '65535', value: String(saved.port ?? 502) });
  const unitInput = h('input', { class: 'input', id: 'mb-unit', type: 'number', min: '0', max: '255', value: String(saved.unitId ?? 1) });
  const timeoutInput = h('input', { class: 'input', id: 'mb-timeout', type: 'number', min: '100', max: '60000', step: '100', value: String(saved.timeoutMs ?? 3000) });
  hostInput.value = saved.host ?? '127.0.0.1';

  const connectButton = h('button', { class: 'btn btn-primary', type: 'submit' }, '連線');
  const disconnectButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '中斷');
  disconnectButton.disabled = true;
  const connectState = h('span', { class: 'result-target empty' }, '未連線');
  const guardInput = h('input', { type: 'checkbox' });
  const guardHint = h('span', { class: 'field-hint' }, '開啟後面板與 Agent 都無法寫入。只有這裡能解鎖。');
  const presetSelect = select(
    [{ id: '', label: '目前連線' }, ...state.profiles.map((entry) => ({ id: entry.name, label: entry.name }))],
    state.activeProfile,
    'mb-preset',
  );
  const presetNameInput = h('input', { class: 'input', id: 'mb-preset-name', placeholder: '裝置名稱', autocomplete: 'off' });
  const savePresetButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '儲存裝置');
  const deletePresetButton = h('button', { class: 'btn btn-ghost', type: 'button', disabled: state.activeProfile === '' }, '刪除裝置');
  const presetRow = h('div', { class: 'grid-form preset-row' },
    field('已存裝置', presetSelect, '選擇裝置時會先中斷目前連線'),
    field('裝置名稱', presetNameInput, '留白時使用 IP、埠號和站號'),
    h('div', { class: 'form-actions' }, savePresetButton, deletePresetButton),
  );

  const connectionForm = h(
    'form',
    { class: 'card-body', novalidate: '' },
    presetRow,
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
  const countInput = h('input', { class: 'input', id: 'mb-count', type: 'number', min: '1', max: '125', value: String(saved.count ?? 16) });
  const scaleInput = h('input', { class: 'input', id: 'mb-scale', type: 'number', step: 'any', value: String(saved.scale ?? 1) });
  const offsetInput = h('input', { class: 'input', id: 'mb-offset', type: 'number', step: 'any', value: String(saved.offset ?? 0) });
  const readButton = h('button', { class: 'btn btn-primary', type: 'submit' }, '讀取');
  const pollButton = h('button', { class: 'btn btn-ghost', type: 'button', disabled: true }, '開始輪詢');
  const pollIntervalInput = h('input', { class: 'input', id: 'mb-poll-ms', type: 'number', min: '200', max: '60000', step: '100', value: String(saved.pollIntervalMs ?? 1000) });
  const readState = h('span', { class: 'result-target empty' }, '尚未讀取');

  const readForm = h(
    'form',
    { class: 'card-body', novalidate: '' },
    h(
      'div',
      { class: 'grid-form' },
      field('資料表', kindSelect, '保持／輸入暫存器是 16 位；線圈／離散輸入是位元'),
      field('起始位址', startInput, '0 – 65535'),
      field('數量', countInput, '保持／輸入暫存器每次最多 125；線圈／離散輸入每次最多 2000'),
      field('型別', typeSelect, '32 位型別佔兩個暫存器'),
      field('字序', orderSelect, '32 位值的四種排列'),
      field('工程比例', scaleInput, '例如 0.1：暫存器 235 顯示 23.5'),
      field('位移', offsetInput, '套用順序：值 × scale + offset'),
      h(
        'div',
        { class: 'field' },
        h('label', {}, '輪詢'),
        pollButton,
        pollIntervalInput,
        h('span', { class: 'field-hint' }, '間隔 200 – 60000 ms；慢設備請調大，避免堆積'),
      ),
    ),
    h('div', { class: 'form-actions' }, readButton, h('span', { class: 'form-actions-spacer' }), readState),
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
          pollIntervalMs: Number(pollIntervalInput.value),
          profiles: state.profiles,
          activeProfile: state.activeProfile,
        }),
      );
    } catch {
      /* 私密模式可能拒绝写入，不影响操作 */
    }
  }

  function renderPresets() {
    presetSelect.replaceChildren(
      h('option', { value: '' }, '目前連線'),
      ...state.profiles.map((entry) => h('option', { value: entry.name }, entry.name)),
    );
    presetSelect.value = state.activeProfile;
    deletePresetButton.disabled = state.activeProfile === '';
    savePresetButton.disabled = hostInput.value.trim() === '';
  }

  function savePreset() {
    const host = hostInput.value.trim();
    if (!host) {
      toast('請先填位址', 'error');
      hostInput.focus();
      return;
    }
    const name = presetNameInput.value.trim() || `${host}:${portInput.value.trim()} / ${unitInput.value.trim()}`;
    state.profiles = [
      ...state.profiles.filter((entry) => entry.name !== name),
      { name, host, port: portInput.value, unitId: unitInput.value },
    ];
    state.activeProfile = name;
    presetNameInput.value = '';
    renderPresets();
    persist();
    toast('已儲存裝置', 'ok');
  }

  async function choosePreset() {
    const name = presetSelect.value;
    state.activeProfile = name;
    if (name) {
      const profile = state.profiles.find((entry) => entry.name === name);
      if (profile) {
        if (state.connected) await disconnect();
        hostInput.value = profile.host;
        portInput.value = String(profile.port);
        unitInput.value = String(profile.unitId);
      }
    }
    renderPresets();
    persist();
  }

  function clearReadResult() {
    state.rows = null;
    resultCard.hidden = true;
    readState.textContent = '尚未讀取';
    readState.className = 'result-target empty';
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
    hostInput.disabled = state.connected;
    portInput.disabled = state.connected;
    connectButton.disabled = state.connected;
    disconnectButton.disabled = !state.connected;
    readButton.disabled = !state.connected;
    pollButton.disabled = !state.connected && !state.polling;
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
      toast('請先填位址', 'error');
      hostInput.focus();
      return;
    }
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
      await refreshConnection();
      await read({ silent: true });
    } catch (error) {
      reportError(error);
    }
  }

  async function disconnect() {
    stopPolling();
    try {
      const { result, text } = await invokeCommand('modbus_connection', { action: 'disconnect' });
      applySnapshot(result);
      state.rows = null;
      resultCard.hidden = true;
      readState.textContent = '尚未讀取';
      readState.className = 'result-target empty';
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
      const maxCount = kindSelect.value === 'coil' || kindSelect.value === 'discrete' ? 2000 : 125;
      const requestedCount = Number(countInput.value);
      if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > maxCount) {
        throw new ApiError('invalid-parameter', `此資料表數量需介於 1 到 ${maxCount}`, { field: 'count' });
      }
      const began = Date.now();
      const { result, text } = await invokeCommand('modbus_read', readInput());
      const previous = state.rows;
      if (previous?.kind === result.kind && previous?.type === result.type) {
        if (Array.isArray(result.bits)) {
          const before = new Map((previous.bits ?? []).map((on, index) => [previous.start + index, on]));
          result.changed = result.bits.flatMap((on, index) => before.has(result.start + index) && before.get(result.start + index) !== on ? [result.start + index] : []);
        } else {
          const before = new Map((previous.rows ?? []).map((row) => [row.address, `${row.text}|${row.raw.join(',')}`]));
          result.changed = (result.rows ?? []).filter((row) => before.has(row.address) && before.get(row.address) !== `${row.text}|${row.raw.join(',')}`).map((row) => row.address);
        }
      }
      state.rows = result;
      state.pollFailures = 0;
      renderResult(result);
      outputCard.show(text, Date.now() - began);
      readState.textContent = `${result.chunks} 次請求 · ${formatDuration(result.latencyMs)}`;
      readState.className = 'result-target';
      setStatus('idle', `讀到 ${Array.isArray(result.bits) ? result.bits.length : (result.rows ?? []).length} 個值`);
      persist();
      return result;
    } catch (error) {
      if (!silent || ++state.pollFailures >= 3) stopPolling();
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
          class: result.changed?.includes(address) ? 'chip result-changed' : 'chip',
            type: 'button',
            'data-active': String(on),
            title: `${address} = ${on ? 1 : 0}（點一下切換）`,
            disabled: !state.connected || state.readOnly || result.kind !== 'coil',
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
            setStatus('idle', `已切換 ${written.address} → ${written.value}`);
            await refreshConnection();
            await read({ silent: true });
          } catch (error) {
            reportError(error, null, outputCard);
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
    const head = h('tr', {}, h('th', {}, '位址'), h('th', {}, '值'), h('th', {}, '原始字組'), h('th', {}, '位元'), h('th', {}, '寫入'));
    const body = h('tbody');
    for (const row of result.rows ?? []) {
      const writable = state.connected && !state.readOnly && result.kind === 'holding';
      const valueInput = h('input', {
        class: 'input inline-write-input',
        type: 'number',
        step: 'any',
        placeholder: String(row.text),
        'aria-label': `寫入位址 ${row.address}`,
      });
      const inlineWrite = h('button', { class: 'btn btn-ghost', type: 'button', disabled: !writable }, '寫入');
      inlineWrite.addEventListener('click', async () => {
        const value = Number(valueInput.value);
        if (valueInput.value.trim() === '' || !Number.isFinite(value)) {
          toast('請輸入有效數值', 'error');
          valueInput.focus();
          return;
        }
        try {
          const { result: written, text } = await invokeCommand('modbus_write', {
            kind: 'holding', address: row.address, value,
            type: result.type, wordOrder: result.wordOrder, scale: result.scale, offset: result.offset,
          });
          outputCard.show(text);
          setStatus('idle', `已寫入位址 ${row.address}，正在讀回更新結果`);
          valueInput.value = '';
          await refreshConnection();
          await read({ silent: true });
        } catch (error) {
          reportError(error, null, outputCard);
        }
      });
      valueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); inlineWrite.click(); }
      });
      const bits = result.width === 1
        ? h('div', { class: 'bit-row' }, ...Array.from({ length: 16 }, (_, index) => {
            const bit = 15 - index;
            const on = (((row.raw[0] ?? 0) >> bit) & 1) === 1;
            const bitButton = h('button', {
              class: 'bit-cell', 'data-active': String(on), type: 'button', title: `bit ${bit}: ${on ? 1 : 0}`,
              disabled: !writable,
            }, String(bit));
            bitButton.addEventListener('click', async () => {
              try {
                const { text } = await invokeCommand('modbus_write', {
                  kind: 'holding', address: row.address, bit, value: on ? 0 : 1,
                });
                outputCard.show(text);
                setStatus('idle', `已切換 ${row.address} bit ${bit}`);
                await refreshConnection();
                await read({ silent: true });
              } catch (error) {
                reportError(error, null, outputCard);
              }
            });
            return bitButton;
          }))
        : h('span', { class: 'field-hint' }, '32 位');
      const changed = result.changed?.includes(row.address);
      body.append(
        h(
          'tr',
          { class: changed ? 'result-changed' : '' },
          h('td', {}, String(row.address)),
          h('td', {}, row.text),
          h('td', {}, row.raw.map(hex4).join(' ')),
          h('td', {}, bits),
          h('td', {}, result.kind === 'holding' ? h('div', { class: 'inline-write' }, valueInput, inlineWrite) : h('span', { class: 'field-hint' }, '唯讀')),
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
    if (!state.connected) {
      toast('請先連線', 'error');
      return;
    }
    const intervalMs = Math.max(200, Number(pollIntervalInput.value) || 1000);
    state.polling = true;
    state.pollFailures = 0;
    pollButton.textContent = '停止輪詢';
    pollButton.className = 'btn btn-ghost';
    pollButton.disabled = false;
    liveTag.hidden = false;
    const tick = async () => {
      if (!state.polling) return;
      await read({ silent: true });
      if (state.polling) {
        const nextInterval = Math.min(60000, Math.max(200, Number(pollIntervalInput.value) || intervalMs));
        state.pollTimer = setTimeout(tick, nextInterval);
      }
    };
    void tick();
    persist();
  }

  function stopPolling() {
    state.polling = false;
    liveTag.hidden = true;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    pollButton.textContent = '開始輪詢';
    pollButton.disabled = !state.connected;
  }

  function syncReadOptions() {
    const bits = kindSelect.value === 'coil' || kindSelect.value === 'discrete';
    const twoWords = ['u32', 'i32', 'f32'].includes(typeSelect.value);
    typeSelect.disabled = bits;
    orderSelect.disabled = bits || !twoWords;
    scaleInput.disabled = bits;
    offsetInput.disabled = bits;
    countInput.max = bits ? '2000' : '125';
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
  savePresetButton.addEventListener('click', savePreset);
  deletePresetButton.addEventListener('click', () => {
    if (!state.activeProfile) return;
    state.profiles = state.profiles.filter((entry) => entry.name !== state.activeProfile);
    state.activeProfile = '';
    renderPresets();
    persist();
  });
  presetSelect.addEventListener('change', () => void choosePreset());
  hostInput.addEventListener('input', renderPresets);
  for (const input of [hostInput, portInput, unitInput, timeoutInput, startInput, countInput, scaleInput, offsetInput, pollIntervalInput]) {
    input.addEventListener('change', persist);
  }
  disconnectButton.addEventListener('click', () => void disconnect());
  guardInput.addEventListener('change', () => void toggleGuard());

  readForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void read();
  });
  pollButton.addEventListener('click', () => state.polling ? stopPolling() : startPolling());
  kindSelect.addEventListener('change', () => {
    syncReadOptions();
    clearReadResult();
    persist();
  });
  typeSelect.addEventListener('change', () => {
    syncReadOptions();
    clearReadResult();
    persist();
  });
  for (const input of [orderSelect, startInput, countInput, scaleInput, offsetInput]) {
    input.addEventListener('change', clearReadResult);
  }
  orderSelect.addEventListener('change', persist);

  return {
    element: root,
    async mount() {
      syncReadOptions();
      disconnectButton.disabled = true;
      renderPresets();
      await refreshConnection();
      if (state.connected) await read({ silent: true });
    },
    unmount() {
      stopPolling();
    },
  };
}
