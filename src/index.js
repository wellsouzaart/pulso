/**
 * Pulso — Cloudflare Worker
 * Rotas API + Cron matinal + Web Push
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// ── Router ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }
    });

    // API routes
    if (path === '/api/subscribe' && request.method === 'POST')
      return handleSubscribe(request, env);

    if (path === '/api/pulse-update' && request.method === 'POST')
      return handlePulseUpdate(request, env);

    if (path === '/api/dashboard' && request.method === 'GET')
      return handleDashboard(request, env);

    if (path === '/api/tasks' && request.method === 'POST')
      return handleTasks(request, env);

    if (path === '/api/tasks' && request.method === 'GET')
      return handleGetTasks(request, env);

    // Static assets handled by Cloudflare [assets] config
    return env.ASSETS.fetch(request);
  },

  // ── Cron: roda todo dia útil 10:30 UTC (07:30 BRT) ─────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendMorningBriefing(env));
  }
};

// ── Subscribe (salva push subscription no KV) ────────────────────
async function handleSubscribe(request, env) {
  const { subscription, token } = await request.json();
  if (!subscription) return json({ ok: false, error: 'sem subscription' }, 400);
  const subs = JSON.parse(await env.PULSO_KV.get('push_subscriptions') || '[]');
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (!exists) subs.push(subscription);
  await env.PULSO_KV.put('push_subscriptions', JSON.stringify(subs));
  return json({ ok: true });
}

// ── Pulse Update (sites enviam dados) ────────────────────────────
async function handlePulseUpdate(request, env) {
  const key = request.headers.get('X-Pulso-Key');
  if (key !== env.PULSO_SITE_KEY) return json({ ok: false }, 401);

  const { site, type, data, timestamp } = await request.json();
  const feed = JSON.parse(await env.PULSO_KV.get('site_feed') || '[]');
  feed.unshift({ site, type, data, timestamp: timestamp || Date.now() });
  // Mantém só os últimos 50 eventos
  await env.PULSO_KV.put('site_feed', JSON.stringify(feed.slice(0, 50)));

  // Notificação imediata para eventos importantes
  const urgent = ['new_concurso', 'new_order', 'resultado_pending'];
  if (urgent.includes(type)) {
    await sendPush(env, {
      title: siteLabels[site] || site,
      body: eventLabel(type, data),
      url: '/'
    });
  }

  return json({ ok: true });
}

// ── Dashboard (feed dos sites + tarefas) ─────────────────────────
async function handleDashboard(request, env) {
  const [feed, tasks] = await Promise.all([
    env.PULSO_KV.get('site_feed'),
    env.PULSO_KV.get('tasks')
  ]);
  return json({
    ok: true,
    feed: JSON.parse(feed || '[]'),
    tasks: JSON.parse(tasks || '[]')
  });
}

// ── Tasks ─────────────────────────────────────────────────────────
async function handleTasks(request, env) {
  const body = await request.json();
  await env.PULSO_KV.put('tasks', JSON.stringify(body.tasks || []));
  return json({ ok: true });
}

async function handleGetTasks(request, env) {
  const raw = await env.PULSO_KV.get('tasks');
  return json({ ok: true, tasks: JSON.parse(raw || '[]') });
}

// ── Morning Briefing ──────────────────────────────────────────────
async function sendMorningBriefing(env) {
  const [feedRaw, tasksRaw] = await Promise.all([
    env.PULSO_KV.get('site_feed'),
    env.PULSO_KV.get('tasks')
  ]);

  const feed = JSON.parse(feedRaw || '[]');
  const tasks = JSON.parse(tasksRaw || '[]');
  const pendingTasks = tasks.filter(t => !t.done);
  const todayEvents = feed.filter(e => {
    const age = Date.now() - e.timestamp;
    return age < 86400000; // últimas 24h
  });

  // Gera briefing com Gemini
  let briefingText = '';
  try {
    const prompt = `Você é o Pulso, assistente de Well Souza. É manhã de hoje no Brasil.

Tarefas pendentes (${pendingTasks.length}):
${pendingTasks.slice(0, 5).map(t => '- ' + t.text).join('\n') || 'Nenhuma'}

Eventos recentes dos sites:
${todayEvents.slice(0, 5).map(e => `- [${e.site}] ${eventLabel(e.type, e.data)}`).join('\n') || 'Nada novo'}

Gere um briefing matinal em 2 frases curtas: o que está pendente e qual deve ser o foco do dia. Seja direto e motivador. PT-BR.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await res.json();
    briefingText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    briefingText = `${pendingTasks.length} tarefas pendentes. Bom dia!`;
  }

  await sendPush(env, {
    title: '☀️ Bom dia, Well',
    body: briefingText || `${pendingTasks.length} tarefas hoje`,
    url: '/?tab=dia'
  });
}

// ── Web Push ──────────────────────────────────────────────────────
async function sendPush(env, { title, body, url }) {
  const subsRaw = await env.PULSO_KV.get('push_subscriptions');
  const subs = JSON.parse(subsRaw || '[]');
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, url });

  await Promise.allSettled(subs.map(sub =>
    sendWebPush(sub, payload, env.VAPID_PUBLIC, env.VAPID_PRIVATE)
  ));
}

async function sendWebPush(subscription, payload, vapidPublic, vapidPrivate) {
  // RFC8291 Web Push com VAPID
  const endpoint = subscription.endpoint;
  const auth = subscription.keys.auth;
  const p256dh = subscription.keys.p256dh;

  const vapidHeaders = await buildVapidHeaders(endpoint, vapidPublic, vapidPrivate);
  const encrypted = await encryptPayload(payload, p256dh, auth);

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400'
    },
    body: encrypted
  });
}

async function buildVapidHeaders(endpoint, publicKey, privateKeyPkcs8) {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: origin, exp: now + 43200, sub: 'mailto:well@pulso.app' };

  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify(claims));
  const sigInput = `${header}.${payload}`;

  const privKey = await crypto.subtle.importKey(
    'pkcs8', base64urlToBuffer(privateKeyPkcs8),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey,
    new TextEncoder().encode(sigInput)
  );

  const token = `${sigInput}.${bufToBase64url(sig)}`;
  return {
    'Authorization': `vapid t=${token}, k=${publicKey}`
  };
}

async function encryptPayload(payload, p256dhB64, authB64) {
  const enc = new TextEncoder();
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const serverPubRaw = await crypto.subtle.exportKey('raw', serverKeys.publicKey);
  const clientPub = await crypto.subtle.importKey('raw', base64urlToBuffer(p256dhB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverKeys.privateKey, 256);
  const authBuf = base64urlToBuffer(authB64);

  const prk = await hkdf(authBuf, new Uint8Array(sharedBits),
    concat(enc.encode('WebPush: info\0'), base64urlToBuffer(p256dhB64), serverPubRaw), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(enc.encode(payload), new Uint8Array([2]));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data);

  // Build aes128gcm content-encoding header
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([serverPubRaw.byteLength]), serverPubRaw);
  return concat(header, new Uint8Array(encrypted));
}

// ── Helpers ───────────────────────────────────────────────────────
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(new Uint8Array(a), offset); offset += a.byteLength; }
  return out;
}

function base64urlToBuffer(b64) {
  const b = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bufToBase64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64url(str) { return bufToBase64url(new TextEncoder().encode(str)); }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const siteLabels = {
  'concursos': 'Concursos Literários',
  'benfazeja': 'Benfazeja',
  'luasites': 'Luasites/CRM',
  'wellsouza': 'wellsouza.com.br'
};

function eventLabel(type, data) {
  const map = {
    new_concurso: () => `Novo concurso: ${data?.title || ''}`,
    prazo_ending: () => `Prazo em ${data?.days || '?'} dias: ${data?.title || ''}`,
    resultado_pending: () => `Resultado pendente: ${data?.title || ''}`,
    new_order: () => `Novo pedido: ${data?.product || ''} — R$${data?.value || ''}`,
    email_stats: () => `Email: ${data?.sent || 0} enviados, ${data?.open_rate || 0}% abertura`,
    new_contact: () => `Novo contato: ${data?.name || data?.email || ''}`,
    calendar_event: () => `Evento: ${data?.title || ''}`
  };
  return (map[type] || (() => type))();
}
