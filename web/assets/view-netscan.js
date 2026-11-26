/**
 * netscan 面板。
 *
 * 设计原则：面板是命令的「图形外壳」，不是另一套实现。
 *   - 所有网络动作都通过 invokeCommand() 打到同一份命令处理器
 *   - 表单值只是命令 input 的可视化编辑，提交前不额外校验（让核心报错，错误信息只有一份）
 *   - 轮询用 netscan_get_scan，参数与 Agent 完全一致
 *
 * 界面分三段：扫描设定 → 进度 → 结果。进度卡在空闲时隐藏，避免空版面。
 */
import { invokeCommand, ApiError } from './api.js';
import { h, clear, field, formatDuration, formatClock, toast } from './dom.js';
import { createOutputCard } from './output-card.js';

const PRESETS = [
  { id: 'fast', label: '快速', hint: '3 埠', ports: [80, 443, 22] },
  { id: 'standard', label: '標準', hint: '10 埠', ports: [21, 22, 23, 80, 135, 139, 443, 445, 3389, 8080] },
  {
    id: 'common',
    label: '常見',
    hint: '18 埠',
    ports: [22, 80, 135, 139, 443, 445, 1433, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9000, 9200, 27017, 11211],
  },
  { id: 'custom', label: '自訂', hint: '手動輸入', ports: null },
];

const POLL_INTERVAL_MS = 1200;
const STORE_KEY = 'mcps.netscan.form';

/** cidr → [startIp, endIp]，只处理 /24 及更宽的常见情况；解析失败返回 null。 */
function cidrToRange(cidr) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr ?? '');
  if (!match) return null;
  const prefix = Number(match[5]);
  if (prefix < 16 || prefix > 30) return null;
  const base = [1, 2, 3, 4].map((index) => Number(match[index]));
  if (base.some((part) => part > 255)) return null;
  const size = 2 ** (32 - prefix);
  // >>> 0：& 的結果是 32 位有號整數，位址 >= 2^31（第一個八位元組 >= 128）會變負數，
  // 後續 toIp 的除法就會吐出負的八位元組。轉回無號才是正確的網路位址。
  const startInt = (base.reduce((accumulator, part) => accumulator * 256 + part, 0) & ~(size - 1)) >>> 0;
  const toIp = (value) => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
  // 跳过网络位与广播位
  return [toIp(startInt + 1), toIp(startInt + size - 2)];
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function compareIp(a, b) {
  const left = ipToInt(a.ip) ?? 0;
  const right = ipToInt(b.ip) ?? 0;
  return left - right;
}

const SORTERS = {
  ip: compareIp,
  hostname: (a, b) => (a.hostname ?? '~').localeCompare(b.hostname ?? '~'),
  mac: (a, b) => (a.mac ?? '~').localeCompare(b.mac ?? '~'),
  ports: (a, b) => a.ports.length - b.ports.length || compareIp(a, b),
  latencyMs: (a, b) => a.latencyMs - b.latencyMs || compareIp(a, b),
  via: (a, b) => a.via.localeCompare(b.via) || compareIp(a, b),
};

export function createNetscanView({ setStatus }) {
  // ---- 状态
  const saved = readSavedForm();
  const state = {
    jobId: saved.jobId ?? null,
    running: false,
    phase: 'idle',
    ports: saved.ports ?? PRESETS[1].ports.slice(),
    preset: saved.preset ?? 'standard',
    hosts: [],
    snapshot: saved.snapshot ?? null,
    sort: { key: 'ip', dir: 'asc' },
    pollTimer: null,
    tickTimer: null,
    pollFailures: 0,
  };

  // ---- 控件
  const interfaceChips = h('div', { class: 'chip-row' }, h('span', { class: 'chip', 'data-active': 'false' }, '讀取中…'));
  const startInput = h('input', { class: 'input', id: 'start-ip', placeholder: '192.168.0.1', autocomplete: 'off', spellcheck: 'false' });
  const endInput = h('input', { class: 'input', id: 'end-ip', placeholder: '192.168.0.254', autocomplete: 'off', spellcheck: 'false' });
  const portsInput = h('input', { class: 'input', id: 'ports', placeholder: '80,443,8000-8010', autocomplete: 'off', spellcheck: 'false' });
  const timeoutInput = h('input', { class: 'input', id: 'timeout', type: 'number', min: '50', max: '10000', step: '50', value: String(saved.timeoutMs ?? 700) });
  const concurrencyInput = h('input', { class: 'input', id: 'concurrency', type: 'number', min: '1', max: '128', step: '1', value: String(saved.concurrency ?? 48) });
  const resolveInput = h('input', { type: 'checkbox', checked: saved.resolveNames !== false });
  const presetRow = h('div', { class: 'chip-row', role: 'group', 'aria-label': '連接埠預設' });
  const startButton = h('button', { class: 'btn btn-primary', type: 'submit' }, '開始掃描');
  const stopButton = h('button', { class: 'btn btn-danger', type: 'button', disabled: '' }, '停止');
  const swapButton = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: '第一段 /24 自動填入' }, '用本機網段');
  const formEl = h('form', { class: 'card-body', novalidate: '' });

  startInput.value = saved.startIp ?? '';
  endInput.value = saved.endIp ?? '';
  portsInput.value = Array.isArray(state.ports) ? state.ports.join(',') : '';

  // 行号 + 交换
  formEl.append(
    h(
      'div',
      { class: 'grid-form' },
      h(
        'div',
        { class: 'field span-2' },
        h('label', {}, '本機網段'),
        interfaceChips,
        h('span', { class: 'field-hint' }, '點一下就填入起始/結束位址。掃描目標會自動略過網路位與廣播位。'),
      ),
      field('起始 IP', startInput, '可省略，改用 CIDR：192.168.0.0/24'),
      field('結束 IP', endInput, '與起始 IP 組成閉區間，最多 4096 個位址'),
      h(
        'div',
        { class: 'field span-2' },
        h('label', {}, '探測連接埠'),
        presetRow,
        portsInput,
        h('span', { class: 'field-hint' }, '最多 32 個。支援 80,443 與 8000-8010 混寫。'),
      ),
      field('單次連線逾時 (ms)', timeoutInput, '50 – 10000 ms，愈短愈快但容易誤判'),
      field('並行主機數', concurrencyInput, '1 – 128，同時間探測幾台'),
      h(
        'div',
        { class: 'field' },
        h('label', {}, '解析主機名'),
        h(
          'label',
          { class: 'switch' },
          resolveInput,
          h('span', {}, '對有回應的主機做反向 DNS'),
        ),
        h('span', { class: 'field-hint' }, '會讓掃描變慢，但表格更好讀'),
      ),
    ),
    h(
      'div',
      { class: 'form-actions' },
      startButton,
      stopButton,
      h('span', { class: 'form-actions-spacer' }),
      swapButton,
    ),
  );

  // ---- 進度卡
  const progressFill = h('div', { class: 'progress-fill', style: { width: '0%' } });
  const progressPhase = h('span', { class: 'progress-phase' }, '準備中');
  const progressElapsed = h('span', { class: 'progress-elapsed' }, '0.0 s');
  const statScanned = h('span', { class: 'stat-value' }, '—');
  const statTotal = h('span', { class: 'stat-value' }, '—');
  const statAlive = h('span', { class: 'stat-value is-good' }, '—');
  const statRate = h('span', { class: 'stat-value' }, '—');

  const progressCard = h(
    'section',
    { class: 'card progress-card', hidden: '' },
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'progress-head' }, progressPhase, h('span', { class: 'progress-spacer' }), progressElapsed),
      h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, progressFill),
      h(
        'div',
        { class: 'progress-stats' },
        statBlock(statScanned, '已掃描'),
        statBlock(statTotal, '目標總數'),
        statBlock(statAlive, '有回應'),
        statBlock(statRate, '速度'),
      ),
    ),
  );

  // ---- 结果卡
  const tableBody = h('tbody');
  const tableHead = h('thead');
  const exportButton = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, '匯出 CSV');
  const resultBody = h('div', { class: 'card-body result-body' });
  const liveTag = h('span', { class: 'live-tag', hidden: '' }, '即時更新');
  const resultTarget = h('span', { class: 'card-head-spacer' });
  const resultCard = h(
    'section',
    { class: 'card', hidden: '' },
    h('header', { class: 'card-head' }, h('h2', {}, '結果'), resultTarget, h('span', { class: 'card-head-spacer' }), liveTag, exportButton),
    resultBody,
  );

  const outputCard = createOutputCard({
    hint: '下面這段就是 Agent 端 render() 收到的純文本 —— 面板與 Agent 共用同一個處理器。',
  });

  const root = h(
    'div',
    { class: 'view' },
    h('section', { class: 'card' }, h('header', { class: 'card-head' }, h('h2', {}, '掃描設定')), formEl),
    progressCard,
    resultCard,
    outputCard.element,
  );

  // ---- 渲染：預設晶片
  function renderPresets() {
    clear(presetRow);
    for (const preset of PRESETS) {
      const chip = h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'data-active': String(state.preset === preset.id),
          title: preset.ports ? preset.ports.join(', ') : '手動輸入連接埠',
        },
        preset.label,
        h('small', {}, preset.hint),
      );
      chip.addEventListener('click', () => {
        state.preset = preset.id;
        if (preset.ports) {
          state.ports = preset.ports.slice();
          portsInput.value = preset.ports.join(',');
        } else {
          portsInput.focus();
        }
        renderPresets();
        persist();
      });
      presetRow.append(chip);
    }
  }

  // ---- 渲染：網段晶片
  async function loadInterfaces() {
    try {
      const { result } = await invokeCommand('netscan_list_interfaces', {});
      clear(interfaceChips);
      if (!result.count) {
        interfaceChips.append(h('span', { class: 'chip' }, '找不到非內部 IPv4 介面'));
        return;
      }
      for (const entry of result.interfaces) {
        const chip = h(
          'button',
          { class: 'chip', type: 'button', title: `${entry.address} / ${entry.netmask}` },
          entry.name,
          h('small', {}, entry.cidr),
        );
        chip.addEventListener('click', () => {
          const range = cidrToRange(entry.cidr);
          if (!range) {
            toast(`${entry.cidr} 網段過大或格式特殊，請手動輸入範圍`, 'info');
            return;
          }
          startInput.value = range[0];
          endInput.value = range[1];
          clearFieldError();
          persist();
        });
        interfaceChips.append(chip);
      }
    } catch (error) {
      clear(interfaceChips);
      interfaceChips.append(h('span', { class: 'chip' }, '介面讀取失敗'));
      reportError(error);
    }
  }

  // ---- 錯誤呈現
  function clearFieldError() {
    startInput.removeAttribute('aria-invalid');
    portsInput.removeAttribute('aria-invalid');
  }

  function reportError(error) {
    const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
    const code = error instanceof ApiError ? error.code : 'unknown';
    toast(`${code}: ${message}`, 'error');
    if (error instanceof ApiError) {
      if (error.field === 'startIp' || error.field === 'target') startInput.setAttribute('aria-invalid', 'true');
      if (error.field === 'ports') portsInput.setAttribute('aria-invalid', 'true');
    }
  }

  // ---- 進度更新
  function applySnapshot(snapshot) {
    const total = snapshot.total || 0;
    const scanned = snapshot.scanned || 0;
    const done = snapshot.status !== 'running';
    const percent = total > 0 ? Math.min(100, (scanned / total) * 100) : done ? 100 : 0;

    progressCard.hidden = false;
    progressFill.style.width = `${percent.toFixed(1)}%`;
    progressFill.dataset.indeterminate = String(!done && scanned === 0);
    progressPhase.textContent = phaseLabel(snapshot);
    progressPhase.dataset.tone = done ? (snapshot.status === 'succeeded' ? 'ok' : 'warn') : 'busy';
    statScanned.textContent = scanned.toLocaleString('zh-TW');
    statTotal.textContent = total.toLocaleString('zh-TW');
    statAlive.textContent = (snapshot.aliveCount || 0).toLocaleString('zh-TW');
    const seconds = (snapshot.elapsedMs || 0) / 1000;
    statRate.textContent = seconds > 0.2 ? `${(scanned / seconds).toFixed(0)} /s` : '—';

    state.snapshot = snapshot;
    state.hosts = snapshot.hosts ?? [];

    if (done) {
      stopTimers();
      state.running = false;
      startButton.disabled = false;
      stopButton.disabled = true;
      if (snapshot.status === 'succeeded') {
        setStatus('idle', `掃描完成：${snapshot.aliveCount} 台主機有回應`, `job ${snapshot.jobId}`);
        toast(`掃描完成，找到 ${snapshot.aliveCount} 台主機`, 'ok');
      } else if (snapshot.status === 'cancelled') {
        setStatus('idle', '掃描已停止，保留部分結果', `job ${snapshot.jobId}`);
        toast('掃描已停止', 'info');
      } else {
        setStatus('error', `掃描失敗：${snapshot.error?.message ?? '未知錯誤'}`);
        if (snapshot.error) toast(`${snapshot.error.code}: ${snapshot.error.message}`, 'error');
      }
    } else {
      state.running = true;
      startButton.disabled = true;
      stopButton.disabled = false;
      setStatus('busy', `掃描中 ${scanned}/${total}`, `${snapshot.aliveCount} 台有回應`);
    }

    renderResults();
    persist();
  }

  function phaseLabel(snapshot) {
    if (snapshot.status === 'succeeded') return '已完成';
    if (snapshot.status === 'cancelled') return '已停止';
    if (snapshot.status === 'failed') return '失敗';
    const phases = { idle: '排隊中', probing: 'TCP 探測', arp: 'ARP 補充', resolving: '解析名稱', done: '收尾' };
    return phases[snapshot.phase] ?? snapshot.phase ?? '掃描中';
  }

  function renderResults() {
    const hosts = sortedHosts();
    resultCard.hidden = false;
    liveTag.hidden = state.snapshot?.status !== 'running';
    resultTarget.textContent = state.snapshot?.target ?? '';
    resultTarget.className = state.snapshot?.target ? 'result-target mono' : 'result-target mono empty';
    exportButton.disabled = hosts.length === 0;

    clear(resultBody);
    if (hosts.length === 0) {
      resultBody.append(
        h(
          'div',
          { class: 'empty' },
          h('span', { class: 'empty-title' }, state.snapshot?.status === 'running' ? '正在等待回應…' : '這次掃描沒有找到主機'),
          state.snapshot?.status === 'running'
            ? '有主機連通就會出現在這裡。'
            : '可能是網段不對、目標全在離線狀態，或防火牆攔掉了所有探測。',
        ),
      );
      return;
    }

    clear(tableHead);
    const headerRow = h('tr');
    for (const [key, label] of [
      ['ip', 'IP 位址'],
      ['hostname', '主機名'],
      ['mac', 'MAC'],
      ['ports', '開放連接埠'],
      ['latencyMs', '延遲'],
      ['via', '來源'],
    ]) {
      const active = state.sort.key === key ? state.sort.dir : undefined;
      const th = h('th', { 'data-sort': active ?? '' }, label);
      th.addEventListener('click', () => {
        if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else Object.assign(state.sort, { key, dir: 'asc' });
        renderResults();
      });
      headerRow.append(th);
    }
    tableHead.append(headerRow);

    clear(tableBody);
    for (const host of hosts) {
      tableBody.append(
        h(
          'tr',
          {},
          h('td', { class: 'mono' }, host.ip),
          h('td', { class: host.hostname ? 'mono' : 'dim mono' }, host.hostname ?? '—'),
          h('td', { class: host.mac ? 'mono' : 'dim mono' }, host.mac ?? '—'),
          h(
            'td',
            {},
            host.ports.length === 0
              ? h('span', { class: 'dim' }, '未探測到')
              : host.ports.map((port) => h('span', { class: 'port-pill' }, String(port))),
          ),
          h('td', { class: 'mono' }, host.via === 'arp' ? '—' : `${host.latencyMs} ms`),
          h('td', {}, h('span', { class: 'via-tag', 'data-via': host.via }, host.via)),
        ),
      );
    }

    resultBody.append(h('div', { class: 'table-wrap' }, h('table', { class: 'result' }, tableHead, tableBody)));
  }

  function sortedHosts() {
    const hosts = [...state.hosts];
    const comparator = SORTERS[state.sort.key] ?? compareIp;
    hosts.sort(comparator);
    if (state.sort.dir === 'desc') hosts.reverse();
    return hosts;
  }

  // ---- 轮询
  function stopTimers() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.pollTimer = null;
    state.tickTimer = null;
  }

  function schedulePoll(delay = POLL_INTERVAL_MS) {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(poll, delay);
  }

  function startElapsedTick() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => {
      const elapsed = state.snapshot?.elapsedMs ?? 0;
      progressElapsed.textContent = formatDuration(elapsed + POLL_INTERVAL_MS);
    }, 250);
  }

  async function poll() {
    if (!state.jobId) return;
    try {
      const { result, text } = await invokeCommand('netscan_get_scan', {
        jobId: state.jobId,
        waitMs: 0,
        limit: 200,
      });
      state.pollFailures = 0;
      progressElapsed.textContent = formatDuration(result.elapsedMs);
      outputCard.show(text, result.elapsedMs, result.status === 'failed' ? 'error' : 'ok');
      applySnapshot(result);
      if (result.status === 'running') {
        startElapsedTick();
        schedulePoll();
      } else {
        stopTimers();
        progressElapsed.textContent = formatDuration(result.elapsedMs);
      }
    } catch (error) {
      state.pollFailures += 1;
      // 單次失敗不喊停：網路抖動不該讓整次掃描的 UI 死掉。
      if (state.pollFailures >= 4) {
        stopTimers();
        state.running = false;
        startButton.disabled = false;
        stopButton.disabled = true;
        setStatus('error', '與伺服器失去連線');
        reportError(error);
        return;
      }
      schedulePoll(POLL_INTERVAL_MS * state.pollFailures);
    }
  }

  // ---- 提交
  async function onSubmit(event) {
    event.preventDefault();
    clearFieldError();

    const startIp = startInput.value.trim();
    const endIp = endInput.value.trim();
    const input = {};

    if (startIp && endIp) {
      input.startIp = startIp;
      input.endIp = endIp;
    } else if (startIp) {
      input.target = startIp;
    } else {
      toast('缺少目標：請填入起始 IP，或直接貼一段 CIDR（例如 192.168.0.0/24）。', 'error');
      startInput.setAttribute('aria-invalid', 'true');
      startInput.focus();
      return;
    }

    const portsText = portsInput.value.trim();
    if (portsText !== '') input.ports = portsText;
    const timeoutMs = Number(timeoutInput.value);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) input.timeoutMs = timeoutMs;
    const concurrency = Number(concurrencyInput.value);
    if (Number.isFinite(concurrency) && concurrency > 0) input.concurrency = concurrency;
    input.resolveNames = resolveInput.checked;

    startButton.disabled = true;
    setStatus('busy', '啟動掃描…');
    const startedAt = performance.now();

    try {
      const { result, text } = await invokeCommand('netscan_start_scan', input);
      outputCard.show(text, performance.now() - startedAt, 'ok');
      state.jobId = result.jobId;
      state.hosts = [];
      state.phase = 'probing';
      state.snapshot = {
        jobId: result.jobId,
        status: 'running',
        phase: 'probing',
        progress: 0,
        target: result.target,
        total: result.total,
        scanned: 0,
        aliveCount: 0,
        elapsedMs: 0,
        hasMore: false,
        nextOffset: null,
        hosts: [],
      };
      applySnapshot(state.snapshot);
      startElapsedTick();
      schedulePoll(400);
      persist();
    } catch (error) {
      startButton.disabled = false;
      setStatus('error', '無法啟動掃描');
      reportError(error);
      if (error instanceof ApiError && error.code === 'scan-running' && error.details?.jobId) {
        // 已經有掃描在跑：接上去看，而不是讓使用者卡住。
        state.jobId = error.details.jobId;
        schedulePoll(200);
        toast('已有掃描在執行，已接上它的進度', 'info');
        startButton.disabled = true;
      }
    }
  }

  async function onStop() {
    stopButton.disabled = true;
    setStatus('busy', '正在停止…');
    try {
      const { result, text } = await invokeCommand('netscan_stop_scan', state.jobId ? { jobId: state.jobId } : {});
      outputCard.show(text, undefined, 'ok');
      if (result.jobId) {
        const { result: snapshot } = await invokeCommand('netscan_get_scan', { jobId: result.jobId, waitMs: 0, limit: 200 });
        applySnapshot(snapshot);
      }
    } catch (error) {
      setStatus('error', '停止失敗');
      reportError(error);
      stopButton.disabled = false;
    }
  }

  // ---- 匯出
  function exportCsv() {
    const hosts = sortedHosts();
    const rows = [['ip', 'hostname', 'mac', 'open_ports', 'latency_ms', 'via']];
    for (const host of hosts) {
      rows.push([host.ip, host.hostname ?? '', host.mac ?? '', host.ports.join(' '), String(host.latencyMs), host.via]);
    }
    const csv = rows
      .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(','))
      .join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `netscan-${state.jobId ?? 'results'}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`已匯出 ${hosts.length} 筆`, 'ok');
  }

  // ---- 持久化：重新整理不丟表單與結果
  function persist() {
    const payload = {
      startIp: startInput.value,
      endIp: endInput.value,
      ports: state.ports,
      preset: state.preset,
      timeoutMs: Number(timeoutInput.value) || 700,
      concurrency: Number(concurrencyInput.value) || 48,
      resolveNames: resolveInput.checked,
      jobId: state.jobId,
      snapshot: state.snapshot,
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch {
      /* 私密模式等情況直接忽略 */
    }
  }

  function readSavedForm() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // ---- 事件
  formEl.addEventListener('submit', onSubmit);
  stopButton.addEventListener('click', onStop);
  exportButton.addEventListener('click', exportCsv);
  swapButton.addEventListener('click', () => interfaceChips.querySelector('.chip')?.click());
  portsInput.addEventListener('input', () => {
    const text = portsInput.value.trim();
    state.ports = text;
    persist();
  });

  return {
    element: root,
    async mount() {
      renderPresets();
      renderResults();
      clearFieldError();
      void loadInterfaces();
      if (state.jobId && state.snapshot) {
        applySnapshot(state.snapshot);
        if (state.snapshot.status === 'running') schedulePoll(0);
      } else {
        // 試著接上後端最近的掃描（例如使用者按了重新整理，或從別處啟動）。
        try {
          const { result, text } = await invokeCommand('netscan_get_scan', { waitMs: 0, limit: 200 });
          if (result.status === 'running' || result.hosts.length > 0 || result.scanned > 0) {
            state.jobId = result.jobId;
            state.snapshot = result;
            state.hosts = result.hosts ?? [];
            outputCard.show(text, result.elapsedMs, result.status === 'failed' ? 'error' : 'ok');
            applySnapshot(result);
            if (result.status === 'running') {
              startElapsedTick();
              schedulePoll(0);
            }
          }
        } catch {
          /* 沒有最近掃描就維持空白 */
        }
      }
    },
    unmount() {
      stopTimers();
    },
  };
}

function statBlock(valueNode, label) {
  return h('div', { class: 'stat' }, valueNode, h('span', { class: 'stat-label' }, label));
}
