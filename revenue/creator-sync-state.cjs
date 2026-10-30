// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises'), path = require('node:path');
const { binding, fault, timestamp, month, chinaDay } = require('./model.cjs');
const { createRevenueLedger } = require('./ledger.cjs');
const identityKinds = { bilibili: ['uid'], douyin: ['account-cookie-uid_tt', 'native_uid'],
  kuaishou: ['user_id', 'account-cookie-userId', 'account-cookie-kuaishou.userId'], wechat_channels: ['finder'] };
const sourcesFor = (platform, identityKind) => platform === 'douyin' ? identityKind === 'native_uid' ? ['wallet'] : ['creator_center', 'anchor_dashboard', 'wallet'] : ['creator_center'];
const informative = new Set(['REVENUE_HISTORY_RECENT_DAYS_ONLY', 'REVENUE_ANCHOR_NOT_REQUESTED', 'REVENUE_NATIVE_UNIT_NOT_CNY',
  'REVENUE_LIVE_ANALYTICS_NOT_NET_SETTLEMENT', 'REVENUE_INCENTIVE_PROGRAM_SCOPE_LIMITED', 'REVENUE_HISTORY_PLATFORM_VISIBLE_ONLY',
  'REVENUE_COMPANY_SETTLEMENT_SUBJECT_SCOPE', 'REVENUE_ADDITIONAL_SETTLEMENT_ACCOUNTS_NOT_INCLUDED',
  'REVENUE_WALLET_POSTING_TIME_BASIS', 'REVENUE_WALLET_CATEGORY_LABEL_BASED']);
const unavailable = new Set(['REVENUE_MONTH_UNAVAILABLE', 'REVENUE_MONTH_NOT_PUBLISHED', 'REVENUE_HISTORY_OUTSIDE_WINDOW',
  'REVENUE_VIDEO_INCENTIVE_MOBILE_REQUIRED', 'REVENUE_CATEGORY_ENDPOINT_UNSUPPORTED', 'REVENUE_WALLET_UNCLASSIFIED_INCOME', 'REVENUE_CATEGORY_LIMIT']);
const needsLogin = new Set(['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'REVENUE_WALLET_SESSION_REQUIRED', 'REVENUE_WALLET_LOGIN_REQUIRED',
  'REVENUE_ADDITIONAL_VERIFICATION_REQUIRED', 'REVENUE_MOBILE_AUTHORIZATION_REQUIRED', 'LOGIN_CANCELLED']);
const codes = new Set([...informative, ...unavailable, ...needsLogin, 'ACCOUNT_CHANGED', 'PLATFORM_ACCOUNT_CHANGED', 'REVENUE_DISPOSED',
  'REVENUE_SYNC_STOPPED', 'REVENUE_BUSY', 'REVENUE_STORAGE_INVALID', 'REVENUE_STORAGE_ERROR', 'REVENUE_STORAGE_LIMIT', 'REVENUE_ACCOUNT_MISMATCH',
  'REVENUE_PLATFORM_REJECTED', 'REVENUE_NETWORK_ERROR', 'REVENUE_HTTP_ERROR', 'REVENUE_SCHEMA_CHANGED', 'REVENUE_REQUEST_TIMEOUT',
  'REVENUE_COLLECTION_TIMEOUT', 'REVENUE_RESPONSE_TOO_LARGE', 'REVENUE_PAGE_NOT_READY', 'REVENUE_PAGINATION_INCOMPLETE',
  'REVENUE_WALLET_RECONCILIATION_FAILED', 'REVENUE_WALLET_SNAPSHOT_CHANGED', 'REVENUE_WALLET_HANDOFF_UNAVAILABLE', 'REVENUE_WALLET_TIMEOUT',
  'REVENUE_MONTH_MISMATCH', 'REVENUE_DATE_OUTSIDE_RANGE', 'REVENUE_DATE_UNAVAILABLE', 'REVENUE_UNIT_UNAVAILABLE', 'REVENUE_SUBCENT_PRECISION',
  'CONFLICTING_REVENUE_PERIOD', 'CONFLICTING_REVENUE_TRANSACTION', 'PAGE_CHANGED', 'UNTRUSTED_PAGE',
  'REVENUE_MOBILE_DEVICE_UNAVAILABLE', 'REVENUE_MOBILE_DEVICE_AMBIGUOUS', 'REVENUE_MOBILE_WEBVIEW_UNAVAILABLE', 'REVENUE_MOBILE_PAGE_AMBIGUOUS',
  'REVENUE_MOBILE_PAGE_REQUIRED', 'REVENUE_MOBILE_BRIDGE_UNAVAILABLE', 'REVENUE_MOBILE_IDENTITY_UNAVAILABLE', 'REVENUE_MOBILE_DISCONNECTED']);
const safeCode = value => codes.has(value?.code || value) ? value.code || value : 'REVENUE_SCHEMA_CHANGED';
function syncBinding({ owner, platform, accountId, identityKind }) {
  binding(platform, accountId);
  if (typeof owner !== 'string' || !owner || owner.length > 1000 || !identityKinds[platform].includes(identityKind)) throw fault('INVALID_REVENUE_IDENTITY_KIND');
  return { platform, accountId, identityKind, ownerHash: createHash('sha256').update(owner).digest('hex') };
}
function stateKey(bound) {
  binding(bound?.platform, bound?.accountId);
  if (!/^[a-f0-9]{64}$/.test(bound.ownerHash) || !identityKinds[bound.platform].includes(bound.identityKind)) throw fault('REVENUE_STORAGE_INVALID');
  return createHash('sha256').update(JSON.stringify([bound.ownerHash, bound.platform, bound.accountId, bound.identityKind])).digest('hex');
}
function cleanIssues(issues) {
  if (!Array.isArray(issues) || issues.length > 500) throw fault('REVENUE_SCHEMA_CHANGED');
  return issues.map(item => ({ code: safeCode(item),
    ...(typeof item.source === 'string' && /^(?:bilibili|douyin|kuaishou|wechat_channels)(?:\.[a-z_]+){1,3}$/.test(item.source) ? { source: item.source } : {}),
    ...(item.month !== undefined ? { month: month(item.month) } : {}) }));
}
function cleanState(value, bound) {
  stateKey(bound);
  if (!value || value.schemaVersion !== 2 || value.kind !== 'creator_revenue_sync' ||
    Object.keys(bound).some(key => value[key] !== bound[key]) || !value.ledger || !Array.isArray(value.sources) || value.sources.length > 4) throw fault('REVENUE_STORAGE_INVALID');
  const updatedAt = timestamp(value.updatedAt), current = chinaDay(Math.floor(Date.parse(updatedAt) / 1000)).slice(0, 7);
  const ledger = createRevenueLedger({ platform: bound.platform, accountId: bound.accountId, state: value.ledger }).export();
  const seen = new Set(), sources = value.sources.map(item => {
    if (!sourcesFor(bound.platform, bound.identityKind).includes(item.source) || seen.has(item.source) ||
      !['idle', 'synced', 'partial', 'unavailable', 'needs_login', 'error'].includes(item.status) ||
      !Number.isInteger(item.failures) || item.failures < 0 || item.failures > 1000 || !Array.isArray(item.months) || item.months.length > 1200) throw fault('REVENUE_STORAGE_INVALID');
    seen.add(item.source); const monthsSeen = new Set();
    const months = item.months.map(row => {
      const selected = month(row.month), checkedAt = timestamp(row.checkedAt);
      if (monthsSeen.has(selected) || selected > current || checkedAt > updatedAt || !['observed', 'partial', 'no_data'].includes(row.outcome)) throw fault('REVENUE_STORAGE_INVALID');
      monthsSeen.add(selected); return { month: selected, checkedAt, outcome: row.outcome };
    }).sort((a, b) => a.month.localeCompare(b.month));
    const times = {};
    for (const name of ['lastAttemptAt', 'lastCheckedAt', 'lastSuccessAt', 'nextCheckAt']) if (item[name] != null) {
      times[name] = timestamp(item[name]); if (name !== 'nextCheckAt' && times[name] > updatedAt) throw fault('REVENUE_STORAGE_INVALID');
    }
    const earliestAvailableMonth = item.earliestAvailableMonth === undefined ? undefined : month(item.earliestAvailableMonth);
    const retryMonth = item.retryMonth === undefined ? undefined : month(item.retryMonth);
    if (earliestAvailableMonth && earliestAvailableMonth > current || retryMonth && retryMonth > current) throw fault('REVENUE_STORAGE_INVALID');
    return { source: item.source, status: item.status, failures: item.failures, months, ...times,
      ...(retryMonth ? { retryMonth } : {}),
      ...(item.lastErrorCode ? { lastErrorCode: safeCode(item.lastErrorCode) } : {}),
      ...(earliestAvailableMonth ? { earliestAvailableMonth } : {}), issues: cleanIssues(item.issues || []) };
  });
  return { schemaVersion: 2, kind: 'creator_revenue_sync', ...bound, updatedAt, ledger, sources };
}
function createCreatorRevenueFileStore({ directory } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('An absolute revenue storage directory is required');
  const target = bound => path.join(directory, 'creator-revenue-' + stateKey(bound) + '.json'), limit = 32 * 1024 * 1024;
  return {
    async load(bound) {
      let handle;
      try {
        handle = await fs.open(target(bound), 'r'); if ((await handle.stat()).size > limit) throw fault('REVENUE_STORAGE_LIMIT');
        const text = await handle.readFile('utf8'); if (Buffer.byteLength(text) > limit) throw fault('REVENUE_STORAGE_LIMIT');
        return cleanState(JSON.parse(text), bound);
      } catch (error) { if (error.code === 'ENOENT') return null; throw fault(error.code === 'REVENUE_STORAGE_LIMIT' ? error.code : 'REVENUE_STORAGE_INVALID'); }
      finally { await handle?.close(); }
    },
    async save(bound, value) {
      const text = JSON.stringify(cleanState(value, bound)), file = target(bound), temporary = file + '.' + randomUUID() + '.tmp';
      if (Buffer.byteLength(text) > limit) throw fault('REVENUE_STORAGE_LIMIT');
      let handle;
      try {
        await fs.mkdir(directory, { recursive: true }); handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(text); await handle.sync(); await handle.close(); handle = undefined; await fs.rename(temporary, file);
      } catch { throw fault('REVENUE_STORAGE_ERROR'); }
      finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
    }
  };
}
module.exports = { syncBinding, stateKey, cleanState, cleanIssues, safeCode, informative, unavailable, needsLogin, sourcesFor, createCreatorRevenueFileStore };
