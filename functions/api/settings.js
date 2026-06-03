// GET  /api/settings?token=...
// POST /api/settings  { token: "...", settings: {...} }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

async function authCheck(token, env) {
  if (!token) return false;
  return !!(await env.PULSO_KV.get('token:' + token));
}

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get('token');
  if (!await authCheck(token, env)) return new Response(JSON.stringify({ ok: false, error: 'Não autorizado' }), { status: 401, headers: CORS });
  const raw = await env.PULSO_KV.get('settings');
  return new Response(JSON.stringify({ ok: true, settings: JSON.parse(raw || '{}') }), { headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const { token, settings } = await request.json();
  if (!await authCheck(token, env)) return new Response(JSON.stringify({ ok: false, error: 'Não autorizado' }), { status: 401, headers: CORS });
  await env.PULSO_KV.put('settings', JSON.stringify(settings));
  return new Response(JSON.stringify({ ok: true }), { headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
