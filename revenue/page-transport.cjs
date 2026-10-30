// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
// These self-contained functions execute in the official page's main world.
// Native clients supply their own signatures/session parameters; none are
// copied into the host, persisted in a ledger or exposed to a caller.
async function fetchRevenuePage(descriptor, origin, timeoutMs, maxBytes) {
  if (location.origin !== origin) return { error: 'UNTRUSTED_PAGE' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(descriptor.url, { method: descriptor.method || 'GET',
      headers: { ...(descriptor.method === 'POST' ? { 'content-type': 'application/json' } : {}), ...descriptor.headers },
      ...(descriptor.method === 'POST' ? { body: JSON.stringify(descriptor.body) } : {}),
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (response.status === 401) return { error: 'LOGIN_REQUIRED' };
    if (!response.ok) return { error: 'REVENUE_HTTP_ERROR' };
    if (!/\bjson\b/i.test(response.headers.get('content-type') || '')) return { error: 'REVENUE_SCHEMA_CHANGED' };
    if (Number(response.headers.get('content-length')) > maxBytes) return { error: 'REVENUE_RESPONSE_TOO_LARGE' };
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '', size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return { error: 'REVENUE_RESPONSE_TOO_LARGE' }; }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (location.origin !== origin) return { error: 'PAGE_CHANGED' };
    try { return { body: JSON.parse(text) }; } catch { return { error: 'REVENUE_SCHEMA_CHANGED' }; }
  } catch { return { error: controller.signal.aborted ? 'REVENUE_REQUEST_TIMEOUT' : 'REVENUE_NETWORK_ERROR' }; }
  finally { clearTimeout(timer); }
}
async function nativeRevenuePage(descriptor, origin, timeoutMs, maxBytes) {
  if (location.origin !== origin || new URL(descriptor.url).origin !== origin) return { error: 'UNTRUSTED_PAGE' };
  const path = new URL(descriptor.url).pathname;
  let timer;
  try {
    let operation;
    if (descriptor.transport === 'kuaishou_page') {
      if (origin !== 'https://cp.kuaishou.com' || !['/rest/v2/creator/pc/authority/account/current', '/rest/cp/cooperate/kx/org/member/bill', '/rest/cp/creator/analysis/live/pc/trending'].includes(path)) return { error: 'UNTRUSTED_PAGE' };
      if (typeof window.$http?.post !== 'function') return { error: 'REVENUE_PAGE_NOT_READY' };
      operation = window.$http.post(path, descriptor.body, { universalErrorHandler: false, universalLoading: false, timeout: timeoutMs });
    } else if (descriptor.transport === 'wechat_helper') {
      const prefix = '/cgi-bin/mmfinderassistant-bin/';
      if (origin !== 'https://channels.weixin.qq.com' || !['auth/auth_data', 'income/get-my-finder-income-detail', 'svrkit/MmFinderAssistantLiveSvr/getRelatedMainPart'].some(p => prefix + p === path)) return { error: 'UNTRUSTED_PAGE' };
      if (typeof window.$shareData?.getBaseService !== 'function' || typeof window.requestX?.RequestService !== 'function') return { error: 'REVENUE_PAGE_NOT_READY' };
      const Base = window.$shareData.getBaseService(window.requestX.RequestService);
      const client = new Base([]);
      operation = client.post({ url: path.slice(prefix.length), data: descriptor.body, timeout: timeoutMs });
    } else return { error: 'UNTRUSTED_PAGE' };
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
    const body = await Promise.race([operation, timeout]);
    if (body?.timedOut) return { error: 'REVENUE_REQUEST_TIMEOUT' };
    if (location.origin !== origin) return { error: 'PAGE_CHANGED' };
    if (descriptor.transport === 'kuaishou_page' && body?.result === 109) return { error: 'LOGIN_REQUIRED' };
    if (descriptor.transport === 'wechat_helper' && body?.errCode && window.$shareData.isUserExpiredErrorCode?.(body.errCode)) return { error: 'LOGIN_REQUIRED' };
    const json = JSON.stringify(body);
    if (typeof json !== 'string') return { error: 'REVENUE_SCHEMA_CHANGED' };
    if (new TextEncoder().encode(json).byteLength > maxBytes) return { error: 'REVENUE_RESPONSE_TOO_LARGE' };
    return { body: JSON.parse(json) };
  } catch { return { error: 'REVENUE_NETWORK_ERROR' }; }
  finally { clearTimeout(timer); }
}
module.exports = { fetchRevenuePage, nativeRevenuePage };
