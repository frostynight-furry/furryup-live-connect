// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { createLiveConnect, PLATFORMS } = require('../core/index.cjs');
const fixtureId = value => typeof value === 'string' && /^synthetic-[a-z0-9-]{1,80}$/.test(value);
const eventKeys = new Set(['event_type', 'source_msg_id', 'user_id', 'user_name', 'content',
  'gift_id', 'gift_name', 'gift_count', 'count', 'timestamp', 'watching_count', 'watched_count', 'liked_count']);
const allowedTypes = new Set(['comment', 'gift', 'like', 'enter', 'follow', 'share', 'notice', 'room_stats']);
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.getOwnPropertyNames(value).every(key => keys.includes(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) &&
    Object.getOwnPropertySymbols(value).length === 0;
}
function validateScenario(scenario) {
  if (!exactKeys(scenario, ['fixtureVersion', 'synthetic', 'name', 'steps']) ||
      scenario.fixtureVersion !== 1 || scenario.synthetic !== true ||
      typeof scenario.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(scenario.name) ||
      !Array.isArray(scenario.steps) || !scenario.steps.length || scenario.steps.length > 10_000)
    throw new TypeError('Invalid synthetic fixture envelope');
  for (const step of scenario.steps) {
    if (!exactKeys(step, ['op', 'session', 'platform', 'roomId', 'event', 'expect']) || !fixtureId(step.session))
      throw new TypeError('Invalid synthetic step');
    if (step.op === 'open') {
      if (!PLATFORMS.includes(step.platform) || !fixtureId(step.roomId) || step.event !== undefined || step.expect !== undefined)
        throw new TypeError('Invalid synthetic route');
    } else if (step.op === 'ingest') {
      const event = step.event;
      if (step.platform !== undefined || step.roomId !== undefined ||
          !['accepted', 'duplicate', 'rejected'].includes(step.expect) ||
          !exactKeys(event, [...eventKeys]) || !allowedTypes.has(event.event_type) ||
          !fixtureId(event.source_msg_id) || !Number.isSafeInteger(event.timestamp) ||
          event.timestamp < 0 || event.timestamp > 8_640_000_000_000_000)
        throw new TypeError('Invalid synthetic event');
      for (const [key, value] of Object.entries(event)) {
        if (['user_id', 'gift_id'].includes(key) && !fixtureId(value)) throw new TypeError('Non-synthetic identity');
        if (['user_name', 'content', 'gift_name'].includes(key) &&
            (typeof value !== 'string' || value.length > 1000 || !/合成|synthetic/i.test(value) ||
             /https?:|[\\/]|@|[\u0000-\u001f\u007f]/.test(value))) throw new TypeError('Invalid synthetic text');
        if (['count', 'gift_count', 'watching_count', 'watched_count', 'liked_count'].includes(key) &&
            (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)) throw new TypeError('Invalid synthetic count');
      }
    } else if (!['close', 'select'].includes(step.op) ||
        ['platform', 'roomId', 'event', 'expect'].some(key => step[key] !== undefined)) throw new TypeError('Invalid synthetic operation');
  }
  // Copy the validated plain input so consumer mutation cannot change the run.
  return JSON.parse(JSON.stringify(scenario));
}

/** Synchronous, bounded, offline reference consumer; never starts a collector. */
function replayScenario(input) {
  const scenario = validateScenario(input);
  const denyNetwork = async () => { throw new Error('Synthetic replay must not use the network'); };
  const live = createLiveConnect({ avatarCacheOptions: { fetchImpl: denyNetwork }, profileOptions: { fetchImpl: denyNetwork } });
  const sessions = new Map(), rooms = new Map(), selected = new Map(), closed = new Set();
  const trace = [];
  let rejected = 0;
  const keyOf = value => JSON.stringify([value.platform, value.roomId ?? value.room_id]);
  live.subscribe(event => {
    const key = keyOf(event);
    if (!rooms.has(key)) rooms.set(key, { platform: event.platform, roomId: event.room_id, comments: 0, gifts: 0, signals: 0 });
    const state = rooms.get(key);
    if (event.event_type === 'comment') state.comments++;
    if (event.event_type === 'gift') state.gifts += event.gift_count;
    if (event.count_mode === 'signal') state.signals++;
    if (event.event_type === 'room_stats' && event.watching_count !== undefined) state.watchingCount = event.watching_count;
  });
  try {
    for (const [index, step] of scenario.steps.entries()) {
      if (step.op === 'open') {
        if (sessions.has(step.session)) throw new Error('Synthetic session alias already used');
        sessions.set(step.session, live.openRoom({ platform: step.platform, roomId: step.roomId }));
        trace.push({ index, operation: step.op, session: step.session });
        continue;
      }
      const session = sessions.get(step.session);
      if (!session) throw new Error('Unknown synthetic session');
      if (step.op === 'select') {
        if (closed.has(step.session)) throw new Error('Cannot select a closed session');
        selected.set(session.platform, step.session);
      } else if (step.op === 'close') {
        session.close(); closed.add(step.session);
        if (selected.get(session.platform) === step.session) selected.delete(session.platform);
      } else {
        let accepted, outcome;
        try { accepted = session.ingest(step.event); outcome = accepted ? 'accepted' : 'duplicate'; }
        catch (error) {
          // Only an explicitly closed session is an expected rejection; do not
          // turn unrelated parser or runtime failures into a successful test.
          if (!closed.has(step.session)) throw error;
          outcome = 'rejected'; rejected++;
        }
        if (outcome !== step.expect) throw new Error(`Synthetic expectation failed at step ${index}`);
        const event = accepted && { ...accepted };
        if (event) delete event.received_at; // Wall-clock receipt time is not a replay identity.
        trace.push({ index, operation: step.op, session: step.session, outcome, ...(event && { event }) });
        continue;
      }
      trace.push({ index, operation: step.op, session: step.session });
    }
    return { fixtureVersion: 1, synthetic: true, name: scenario.name,
      accepted: live.stream.accepted, duplicates: live.stream.duplicates, rejected,
      rooms: [...rooms.values()], activeRooms: [...selected.values()].map(alias => rooms.get(keyOf(sessions.get(alias)))).filter(Boolean), trace };
  } finally { live.close(); }
}
module.exports = { replayScenario, validateScenario };
