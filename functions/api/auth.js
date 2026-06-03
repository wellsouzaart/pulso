// POST /api/auth  { action: "login", password: "..." }
// POST /api/auth  { action: "verify", token: "..." }

export async function onRequestPost({ request, env }) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const { action, password, token } = await request.json();

    if (action === 'login') {
      const correct = await verifyPassword(password, env.PULSO_PASSWORD_HASH);
      if (!correct) {
        return new Response(JSON.stringify({ ok: false, error: 'Senha incorreta' }), { status: 401, headers: cors });
      }
      const tok = await generateToken(env.PULSO_SECRET);
      await env.PULSO_KV.put('token:' + tok, '1', { expirationTtl: 60 * 60 * 24 * 30 }); // 30 dias
      return new Response(JSON.stringify({ ok: true, token: tok }), { headers: cors });
    }

    if (action === 'verify') {
      const valid = await env.PULSO_KV.get('token:' + token);
      return new Response(JSON.stringify({ ok: !!valid }), { headers: cors });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Ação inválida' }), { status: 400, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

async function verifyPassword(input, storedHash) {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === storedHash;
}

async function generateToken(secret) {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
