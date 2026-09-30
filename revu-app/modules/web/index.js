// revu's module on the web (exact2 LLP 1067.000): the browser Notification
// API behind the same `later` ops the Swift module answers; a click comes
// back as a device change (`changed('notifications')`) that a watching source
// drains. Under the agent nothing is asked of the browser.
export const abi = 1;
export const roster = { 'revu-notifier': { snapshot: false } };

const context = {
  agent: typeof location !== 'undefined' && new URL(location.href).searchParams.has('agent'),
  now: () => performance.now(),
  changed: () => {},
};

const state = {
  pending: [],
  records: new Map(), // id → data
  open: new Map(), // id → Notification
  remembered: [],
};

function permission() {
  if (context.agent) return 'granted';
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission === 'default' ? 'not-determined' : Notification.permission;
}

function deliver(id, actionId) {
  const data = state.records.get(id) ?? {};
  state.records.delete(id);
  state.pending.push({ notificationId: id, actionId, data });
  context.changed('notifications');
}

function drain() {
  const out = state.pending;
  state.pending = [];
  return out;
}

export function connect({ changed, agent, now }) {
  context.changed = changed;
  if (typeof agent === 'boolean') context.agent = agent;
  if (typeof now === 'function') context.now = now;
}

export function call(request) {
  switch (request?.op) {
    case 'status': return { available: context.agent || typeof Notification !== 'undefined', permission: permission(), pending: state.pending.length };
    case 'drain': return { actions: drain() };
    default: throw new Error(`the notifier answers no call ${JSON.stringify(request?.op)}`);
  }
}

export async function later(request) {
  switch (request?.op) {
    case 'status':
      return call({ op: 'status' });
    case 'permission': {
      if (context.agent) return { permission: 'granted' };
      if (typeof Notification === 'undefined') return { permission: 'denied' };
      if (Notification.permission === 'default') await Notification.requestPermission();
      return { permission: permission() };
    }
    case 'notify': {
      const id = String(request.id ?? '');
      if (!id) throw new Error('notify needs an id');
      state.records.set(id, request.data ?? {});
      if (context.agent) { state.remembered.push(request); return { id, delivered: 'remembered' }; }
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') throw new Error('notifications are not permitted here');
      const body = [request.subtitle, request.body].filter(Boolean).join('\n');
      const n = new Notification(String(request.title ?? ''), { body, tag: id });
      // The web has no per-notification action buttons outside service workers;
      // a click is the default action.
      n.onclick = () => { deliver(id, 'default'); n.close(); };
      n.onclose = () => { if (state.records.has(id)) deliver(id, 'dismissed'); };
      state.open.set(id, n);
      return { id, delivered: 'posted' };
    }
    case 'close': {
      const id = String(request.id ?? '');
      state.records.delete(id);
      state.open.get(id)?.close();
      state.open.delete(id);
      state.remembered = state.remembered.filter((r) => r.id !== id);
      return { ok: true };
    }
    case 'drain':
      return { actions: drain() };
    case 'simulate': {
      if (!context.agent) throw new Error("simulate is the agent's");
      deliver(String(request.id ?? ''), String(request.actionId ?? 'default'));
      return { ok: true };
    }
    default:
      throw new Error(`the notifier answers no ${JSON.stringify(request?.op)}`);
  }
}

// `<revu-notifier>`: nothing to draw.
class Empty {
  constructor(element) { element.style.display = 'none'; }
  destroy() {}
}
export function create(tag, element) {
  if (tag !== 'revu-notifier') throw new Error(`no view ${tag}`);
  return new Empty(element);
}
export function setProps() {}
export function destroy(handle) { handle.destroy(); }
