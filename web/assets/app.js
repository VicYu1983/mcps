/**
 * 應用外殼。
 *
 * 職責：讀命令目錄 → 決定有哪些模組 → hash 路由 → 掛載對應面板。
 * 這裡刻意不含任何業務邏輯；新增一個模組只要在 MODULES 加一筆。
 *
 * 為什麼要讀目錄再渲染導覽？因為側欄要能誠實反映「伺服器上真的有什麼命令」。
 * 少寫一個模組時，面板會缺一頁，但 Agent 端的工具清單不會騙人 —— 兩邊都來自同一份 registry。
 */
import { fetchCatalog, ApiError } from './api.js';
import { h, clear, toast } from './dom.js';
import { createModbusView } from './view-modbus.js';
import { createNetscanView } from './view-netscan.js';

/** 面板註冊表：command 前綴 → 模組。 */
const MODULES = [
  {
    id: 'netscan',
    prefix: 'netscan_',
    icon: '📡',
    title: '網路掃描',
    desc: '從本機探測 IPv4 網段：TCP 連通性探測 + ARP 快取補充，找出存活主機與開放連接埠。',
    create: createNetscanView,
  },
  {
    id: 'modbus',
    prefix: 'modbus_',
    icon: '🔌',
    title: 'Modbus 讀寫',
    desc: 'Modbus TCP 讀寫台：五種資料型別、四種字序、工程比例、位元切換、輪詢與唯讀鎖定。',
    create: createModbusView,
  },
];

const THEME_KEY = 'mcps.theme';

const els = {
  nav: document.getElementById('nav'),
  content: document.getElementById('content'),
  pageTitle: document.getElementById('page-title'),
  pageDesc: document.getElementById('page-desc'),
  topbarSide: document.getElementById('topbar-side'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  statusMeta: document.getElementById('status-meta'),
  brandSub: document.getElementById('brand-sub'),
  mcpLink: document.getElementById('mcp-link'),
};

let activeView = null;
let activeId = null;
let catalog = [];

/** 全域狀態列，面板透過它回報。 */
function setStatus(state, text, meta = '') {
  els.statusDot.dataset.state = state;
  els.statusText.textContent = text;
  els.statusMeta.textContent = meta;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  const button = document.getElementById('theme-toggle');
  if (button) button.textContent = theme === 'light' ? '🌙' : '☀️';
}

function initTheme() {
  let theme = 'dark';
  try {
    theme = localStorage.getItem(THEME_KEY) ?? 'dark';
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

function renderNav() {
  clear(els.nav);
  for (const module of MODULES) {
    const tools = catalog.filter((command) => command.name.startsWith(module.prefix));
    if (tools.length === 0) continue; // 伺服器沒掛這個模組就不顯示，避免點進去一片空白
    const item = h(
      'button',
      {
        class: 'nav-item',
        type: 'button',
        'data-module': module.id,
        ...(activeId === module.id ? { 'aria-current': 'page' } : {}),
      },
      h('span', { class: 'nav-icon' }, module.icon),
      h('span', { class: 'nav-label' }, module.title),
      h('span', { class: 'nav-badge' }, String(tools.length)),
    );
    item.addEventListener('click', () => {
      location.hash = `#/${module.id}`;
    });
    els.nav.append(item);
  }

  const total = catalog.length;
  els.brandSub.textContent = `${total} 個命令`;
}

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const id = raw.split('/')[0];
  const known = MODULES.find((module) => module.id === id);
  return known ?? MODULES[0];
}

function mount(module) {
  if (activeView?.unmount) activeView.unmount();
  clear(els.content);
  clear(els.topbarSide);

  const themeButton = h('button', {
    class: 'btn btn-sm btn-ghost',
    type: 'button',
    id: 'theme-toggle',
    title: '切換明暗',
    onclick: () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'),
  });
  els.topbarSide.append(themeButton);
  themeButton.textContent = document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️';

  const tools = catalog.filter((command) => command.name.startsWith(module.prefix));
  if (tools.length === 0) {
    els.pageTitle.textContent = '模組未載入';
    els.pageDesc.textContent = '伺服器上找不到這個模組的命令。';
    clear(els.content);
    els.content.append(
      h(
        'div',
        { class: 'empty' },
        h('span', { class: 'empty-title' }, `${module.title} 的命令不在目錄裡`),
        `面板期待以 ${module.prefix} 開頭的命令。請確認 src/modules/index.ts 有掛載這個模組。`,
      ),
    );
    activeView = null;
    return;
  }

  els.pageTitle.textContent = module.title;
  els.pageDesc.textContent = module.desc;

  activeView = module.create({ setStatus, catalog: tools });
  activeId = module.id;
  els.content.append(activeView.element);
  if (activeView.mount) activeView.mount();
  renderNav();
}

function route() {
  const module = currentRoute();
  mount(module);
}

async function boot() {
  initTheme();
  setStatus('busy', '讀取命令清單…');
  try {
    catalog = await fetchCatalog();
    setStatus('idle', `就緒 · ${catalog.length} 個命令`, location.host);
    els.mcpLink.href = `${location.origin}/mcp`;
    window.addEventListener('hashchange', route);
    route();
  } catch (error) {
    setStatus('error', '無法讀取命令清單');
    clear(els.content);
    const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
    els.content.append(
      h(
        'div',
        { class: 'empty' },
        h('span', { class: 'empty-title' }, '連不上 MCP Toolbox 的 Web 層'),
        message,
        h('br'),
        h('span', { class: 'field-hint' }, '請確認行程是以 --http 或 --http-only 啟動，且 port 與主機名相符。'),
      ),
    );
    els.pageTitle.textContent = '啟動失敗';
    els.pageDesc.textContent = '';
  }
}

// 面板忘了接住錯誤時，至少讓使用者看到。
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason instanceof ApiError) toast(reason.message, 'error');
});

void boot();
