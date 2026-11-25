/** Web API 客户端。所有请求同源，错误统一抛 ApiError。 */

export class ApiError extends Error {
  constructor(code, message, extras = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.field = extras.field ?? null;
    this.details = extras.details ?? null;
    this.status = extras.status ?? 0;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...options });
  } catch (cause) {
    throw new ApiError('network', `無法連線到伺服器（${cause.message}）`);
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok || payload?.ok === false) {
    const error = payload?.error ?? {};
    throw new ApiError(error.code ?? `http-${response.status}`, error.message ?? `請求失敗（${response.status}）`, {
      field: error.field,
      details: error.details,
      status: response.status,
    });
  }
  return payload;
}

/** 命令清單：title/description/annotations/input JSON Schema。 */
export async function fetchCatalog() {
  const payload = await request('/api/commands');
  return payload.commands ?? [];
}

/** 呼叫命令。成功回 { text, result }，失败抛 ApiError。 */
export async function invokeCommand(name, input) {
  const payload = await request(`/api/commands/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  return { text: payload.text ?? '', result: payload.result ?? {} };
}
