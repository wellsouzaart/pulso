/**
 * Pulso — Cloudflare Worker
 * Rotas API + Cron matinal + Web Push
 */

// ── Contexto de vida do Well — injetado em TODA chamada Gemini ───
const WELL_CONTEXT = `
## Quem é Well Souza
- Editor, designer gráfico e desenvolvedor independente
- Mora no Brasil, trabalha sozinho gerenciando múltiplos projetos editoriais e digitais
- Samsung Galaxy S20 + Galaxy Watch Ultra (SM-R945F)
- Usa Mac, iPad e celular — acessa o Pulso em todos os dispositivos

## Projetos ativos
### Benfazeja Editora (benfazeja.com.br)
- 103 títulos publicados (17 poesia, 6 romance, 6 contos, 5 dramaturgia)
- **Meta 2027:** nome da Benfazeja em lista de finalistas de prêmio literário nacional (Jabuti, Oceanos, SP Literatura)
- Concurso Literário 2025 em planejamento — edital ainda não lançado
- Produção gráfica in-house (custo zero de diagramação/capa)
- Pendente: ficha catalográfica CRB, depósito legal, ISBN próprio, distribuição formal

### Concursos Literários (concursosliterarios.net.br)
- Maior diretório de concursos literários do Brasil
- CRM com 17 organizadores ativos (tags: organizadores / aguardando-resultado)
- Ritual: publicar concurso → email para organizador → encerrar prazo → cobrar resultado
- Monetização via parcerias com organizadores

### Parlatudo (plugin WordPress)
- CRM editorial completo: contatos, projetos, automações de email, IMAP
- Instalado em todos os sites da rede
- parla-mkt: servidor de email centralizado na VPS

### Sites da rede
- wellsouza.com.br — portfólio pessoal
- editoratrevo.com.br — editora parceira
- luasites.com.br — servidor central / parla-mkt

## Objetivos de vida
- **2027:** Benfazeja reconhecida com finalista nacional + concurso 2025 publicado
- **2030:** Negócio editorial sustentável, distribuição nacional, 150+ títulos
- **Aposentadoria:** Renda passiva via catálogo editorial + sistemas digitais

## Infraestrutura técnica
- VPS: 2 cores, 3.8GB RAM (apertada — evitar carga extra)
- Docker: WordPress x4, n8n, Qdrant, Redis, Traefik
- Cloudflare: DNS, Workers, KV, Cron
- Deploy Pulso: cd /var/www/pulso && source .env.deploy && bash deploy.sh

## Como Well prefere trabalhar
- Direto ao ponto — sem rodeios, sem explicações longas
- Prefere ação sobre análise — "já fiz X, próximo passo é Y"
- Quer decisões sugeridas, não só opções
- Gosta de sistemas simples que funcionam, não de complexidade desnecessária
- Idioma: português brasileiro
`;

const BASE_SYSTEM = (extraContext = '') => `Você é o Pulso — secretário pessoal e assistente de Well Souza.

${WELL_CONTEXT}

${extraContext}

## Regras de comportamento
- Respostas curtas no celular (máximo 5 linhas, salvo quando pedir mais)
- Quando houver tarefas ou decisões pendentes, sugira a mais urgente
- Se perceber padrão preocupante (prazo perdido, meta atrasada), avise proativamente
- PT-BR sempre
`;

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

    if (path === '/api/terminal' && request.method === 'POST')
      return handleTerminal(request, env);

    if (path === '/api/email-reply' && request.method === 'POST')
      return handleEmailReply(request, env);

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

  // Notificação push imediata para eventos urgentes
  const pushConfig = {
    new_concurso:       { emoji: '📢', urgent: false },
    prazo_vencendo:     { emoji: '⏰', urgent: true  },
    resultado_pendente: { emoji: '🏆', urgent: true  },
    concurso_encerrado: { emoji: '🔒', urgent: false },
    resultado_publicado:{ emoji: '✅', urgent: false },
    new_order:          { emoji: '💰', urgent: true  },
    new_contact:        { emoji: '👤', urgent: false },
    email_received:     { emoji: '📧', urgent: true  },
  };

  const cfg = pushConfig[type];
  if (cfg?.urgent) {
    await sendPush(env, {
      title: `${cfg.emoji} ${siteLabels[site] || site}`,
      body: eventLabel(type, data),
      url: '/?tab=dia'
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

// ── Terminal ──────────────────────────────────────────────────────
async function handleTerminal(request, env) {
  const { cmd, history } = await request.json();
  if (!cmd) return json({ ok: false, output: 'Comando vazio' });

  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Built-in commands
  if (command === 'help') return json({ ok: true, output: HELP_TEXT });
  if (command === 'clear') return json({ ok: true, output: '', clear: true });

  if (command === 'status') {
    const feed = JSON.parse(await env.PULSO_KV.get('site_feed') || '[]');
    const tasks = JSON.parse(await env.PULSO_KV.get('tasks') || '[]');
    const pending = tasks.filter(t => !t.done).length;
    const last = feed[0];
    return json({ ok: true, output:
      `\x1b[32m● PULSO STATUS\x1b[0m\n` +
      `  Sites conectados : concursos, benfazeja, wellsouza, luasites\n` +
      `  Eventos no feed  : ${feed.length}\n` +
      `  Tarefas pendentes: ${pending}\n` +
      `  Último evento    : ${last ? `[${last.site}] ${last.type} — ${timeAgo(last.timestamp)}` : 'nenhum'}\n`
    });
  }

  if (command === 'feed') {
    const feed = JSON.parse(await env.PULSO_KV.get('site_feed') || '[]');
    if (!feed.length) return json({ ok: true, output: 'Nenhum evento ainda.' });
    const n = parseInt(args[0]) || 10;
    const out = feed.slice(0, n).map((e, i) =>
      `\x1b[33m${String(i+1).padStart(2)}.\x1b[0m [\x1b[36m${e.site}\x1b[0m] \x1b[37m${eventLabel(e.type, e.data)}\x1b[0m\n    \x1b[90m${timeAgo(e.timestamp)}\x1b[0m`
    ).join('\n');
    return json({ ok: true, output: out });
  }

  if (command === 'emails') {
    const feed = JSON.parse(await env.PULSO_KV.get('site_feed') || '[]');
    const emails = feed.filter(e => e.type === 'email_received');
    if (!emails.length) return json({ ok: true, output: 'Nenhum email no feed. Configure o bridge nos sites.' });
    const out = emails.slice(0, 10).map((e, i) =>
      `\x1b[33m[${e.data?.id || i}]\x1b[0m De: \x1b[36m${e.data?.from || '?'}\x1b[0m\n` +
      `    Assunto: ${e.data?.subject || '?'}\n` +
      `    \x1b[90m${timeAgo(e.timestamp)}\x1b[0m`
    ).join('\n\n');
    return json({ ok: true, output: out });
  }

  if (command === 'reply') {
    // reply <email_id> <mensagem...>
    const id = args[0];
    const msg = args.slice(1).join(' ');
    if (!id || !msg) return json({ ok: true, output: 'Uso: reply <email_id> <mensagem>' });
    // Busca email no feed
    const feed = JSON.parse(await env.PULSO_KV.get('site_feed') || '[]');
    const email = feed.find(e => e.type === 'email_received' && String(e.data?.id) === String(id));
    if (!email) return json({ ok: true, output: `\x1b[31mEmail #${id} não encontrado.\x1b[0m Use 'emails' para listar.` });
    // Envia reply via parla-mkt
    try {
      const res = await fetch(`${email.data?.reply_url || ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pulso-Key': env.PULSO_SITE_KEY },
        body: JSON.stringify({ contact_id: email.data?.contact_id, message: msg })
      });
      return json({ ok: true, output: `\x1b[32m✓ Reply enviado para ${email.data?.from}\x1b[0m` });
    } catch(e) {
      return json({ ok: true, output: `\x1b[31mErro ao enviar: ${e.message}\x1b[0m` });
    }
  }

  if (command === 'wp') {
    // wp <site> <subcommand>
    const site = args[0]; const sub = args[1];
    if (!site) return json({ ok: true, output: 'Uso: wp <site> <posts|orders|plugins|option get/set>\nSites: concursos, benfazeja, wellsouza, luasites' });
    const siteUrl = siteUrls[site];
    if (!siteUrl) return json({ ok: true, output: `Site desconhecido: ${site}` });
    const creds = JSON.parse(await env.PULSO_KV.get(`wp_creds_${site}`) || 'null');
    if (!creds) return json({ ok: true, output: `\x1b[33mCredenciais não configuradas para ${site}.\x1b[0m\nRode: wp-auth ${site} <user> <app-password>` });

    const auth = 'Basic ' + btoa(`${creds.user}:${creds.pass}`);
    if (sub === 'posts' || sub === 'list') {
      const r = await fetch(`${siteUrl}/wp-json/wp/v2/posts?per_page=5&status=publish`, { headers: { Authorization: auth } });
      const posts = await r.json();
      if (!Array.isArray(posts)) return json({ ok: true, output: JSON.stringify(posts) });
      const out = posts.map((p, i) => `\x1b[33m${i+1}.\x1b[0m ${p.title?.rendered}\n   \x1b[90m${p.link}\x1b[0m`).join('\n');
      return json({ ok: true, output: out || 'Nenhum post.' });
    }
    if (sub === 'orders') {
      const r = await fetch(`${siteUrl}/wp-json/wc/v3/orders?per_page=5`, { headers: { Authorization: auth } });
      const orders = await r.json();
      if (!Array.isArray(orders)) return json({ ok: true, output: 'WooCommerce não instalado ou sem permissão.' });
      const out = orders.map((o, i) => `\x1b[33m#${o.id}\x1b[0m ${o.billing?.first_name} ${o.billing?.last_name} — R$${o.total} [\x1b[36m${o.status}\x1b[0m]`).join('\n');
      return json({ ok: true, output: out || 'Nenhum pedido.' });
    }
    if (sub === 'plugins') {
      const r = await fetch(`${siteUrl}/wp-json/wp/v2/plugins?per_page=50`, { headers: { Authorization: auth } });
      const plugins = await r.json();
      if (!Array.isArray(plugins)) return json({ ok: true, output: 'Sem acesso a plugins via REST.' });
      const active = plugins.filter(p => p.status === 'active');
      return json({ ok: true, output: `${active.length} plugins ativos:\n` + active.map(p => `  \x1b[32m●\x1b[0m ${p.name}`).join('\n') });
    }
    if (sub === 'option' && args[2] === 'get') {
      const r = await fetch(`${siteUrl}/wp-json/wp/v2/settings`, { headers: { Authorization: auth } });
      const s = await r.json();
      return json({ ok: true, output: JSON.stringify(s, null, 2) });
    }
    return json({ ok: true, output: `Subcomando desconhecido: ${sub}\nDisponíveis: posts, orders, plugins, option get` });
  }

  if (command === 'wp-auth') {
    // wp-auth <site> <user> <app-password>
    const [site, user, ...passParts] = args;
    const pass = passParts.join(' ');
    if (!site || !user || !pass) return json({ ok: true, output: 'Uso: wp-auth <site> <usuario> <app-password>\nCrie em: WP Admin → Usuários → Senhas de aplicativo' });
    await env.PULSO_KV.put(`wp_creds_${site}`, JSON.stringify({ user, pass }));
    return json({ ok: true, output: `\x1b[32m✓ Credenciais salvas para ${site}\x1b[0m` });
  }

  if (command === 'tasks') {
    const tasks = JSON.parse(await env.PULSO_KV.get('tasks') || '[]');
    if (!tasks.length) return json({ ok: true, output: 'Nenhuma tarefa.' });
    const out = tasks.map((t, i) =>
      `${t.done ? '\x1b[32m✓\x1b[0m' : '\x1b[90m○\x1b[0m'} \x1b[33m[${i}]\x1b[0m ${t.done ? '\x1b[90m' + t.text + '\x1b[0m' : t.text}`
    ).join('\n');
    return json({ ok: true, output: out });
  }

  if (command === 'task') {
    const sub = args[0];
    if (sub === 'add') {
      const text = args.slice(1).join(' ');
      if (!text) return json({ ok: true, output: 'Uso: task add <texto>' });
      const tasks = JSON.parse(await env.PULSO_KV.get('tasks') || '[]');
      tasks.push({ text, done: false, created: Date.now() });
      await env.PULSO_KV.put('tasks', JSON.stringify(tasks));
      return json({ ok: true, output: `\x1b[32m✓ Tarefa adicionada: ${text}\x1b[0m` });
    }
    if (sub === 'done') {
      const idx = parseInt(args[1]);
      const tasks = JSON.parse(await env.PULSO_KV.get('tasks') || '[]');
      if (!tasks[idx]) return json({ ok: true, output: `Tarefa ${idx} não encontrada.` });
      tasks[idx].done = true;
      await env.PULSO_KV.put('tasks', JSON.stringify(tasks));
      return json({ ok: true, output: `\x1b[32m✓ ${tasks[idx].text}\x1b[0m` });
    }
    return json({ ok: true, output: 'Subcomandos: task add <texto> | task done <índice>' });
  }

  if (command === 'deploy') {
    return json({ ok: true, output: '\x1b[33mDeploy deve ser rodado na VPS:\x1b[0m\ncd /var/www/pulso && source .env.deploy && bash deploy.sh' });
  }

  // Fallback: Gemini interpreta comando desconhecido
  const geminiOutput = await callGeminiTerminal(cmd, history || [], env);
  return json({ ok: true, output: geminiOutput });
}

async function handleEmailReply(request, env) {
  const { site, contact_id, message, subject } = await request.json();
  const key = request.headers.get('X-Pulso-Key');
  if (key !== env.PULSO_SITE_KEY) return json({ ok: false }, 401);
  // Store reply intent in KV for the site to pick up
  const replies = JSON.parse(await env.PULSO_KV.get('pending_replies') || '[]');
  replies.push({ site, contact_id, message, subject, created: Date.now() });
  await env.PULSO_KV.put('pending_replies', JSON.stringify(replies));
  return json({ ok: true });
}

async function callGeminiTerminal(cmd, history, env) {
  const sysPrompt = BASE_SYSTEM(`
## Modo terminal
Você está no terminal do Pulso. Responda como shell Unix:
- Saída direta, sem markdown, sem explicações longas
- Use ANSI: \\x1b[32m verde, \\x1b[33m amarelo, \\x1b[31m vermelho, \\x1b[0m reset
- Comandos disponíveis: status, feed, emails, reply, wp, tasks, task, help, clear
- Se ambíguo, sugira o comando correto
- Máximo 20 linhas
`);

  const messages = [
    ...history.slice(-6).map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: cmd }] }
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: sysPrompt }] }, contents: messages }) }
  );
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '(sem resposta)';
}

const siteUrls = {
  concursos: 'https://concursosliterarios.net.br',
  benfazeja: 'https://benfazeja.com.br',
  wellsouza: 'https://wellsouza.com.br',
  luasites:  'https://luasites.com.br'
};

const HELP_TEXT = `\x1b[32m╔══════════════════════════════════╗
║        PULSO TERMINAL v1         ║
╚══════════════════════════════════╝\x1b[0m

\x1b[33mSISTEMA\x1b[0m
  status              — estado geral
  feed [n]            — últimos n eventos dos sites
  clear               — limpar tela

\x1b[33mTAREFAS\x1b[0m
  tasks               — listar tarefas
  task add <texto>    — nova tarefa
  task done <idx>     — marcar concluída

\x1b[33mEMAIL\x1b[0m
  emails              — emails recentes
  reply <id> <msg>    — responder email

\x1b[33mWORDPRESS\x1b[0m
  wp <site> posts     — posts recentes
  wp <site> orders    — pedidos WooCommerce
  wp <site> plugins   — plugins ativos
  wp-auth <site> <user> <pass>  — configurar acesso

  Sites: concursos · benfazeja · wellsouza · luasites

\x1b[33mIA\x1b[0m
  Qualquer outro texto → Gemini responde como terminal

\x1b[90mDica: setas ↑↓ para histórico, Tab para completar\x1b[0m`;

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
    const prompt = BASE_SYSTEM() + `\n\nÉ manhã de hoje no Brasil. Gere um briefing matinal em 2 frases curtas.

Tarefas pendentes (${pendingTasks.length}):
${pendingTasks.slice(0, 5).map(t => '- ' + t.text).join('\n') || 'Nenhuma'}

Eventos recentes dos sites:
${todayEvents.slice(0, 5).map(e => `- [${e.site}] ${eventLabel(e.type, e.data)}`).join('\n') || 'Nada novo'}

Responda apenas com o briefing — foco do dia e o que está pendente. Direto e motivador.`;

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
    new_concurso:        () => `Novo: ${data?.title || ''} ${data?.prazo ? '— '+data.prazo : ''}`,
    prazo_vencendo:      () => `⏰ ${data?.dias}d: ${data?.title || ''} (${data?.prazo || ''})`,
    prazo_ending:        () => `Prazo em ${data?.days || '?'} dias: ${data?.title || ''}`,
    concurso_encerrado:  () => `Encerrado: ${data?.title || ''}`,
    resultado_pendente:  () => `🏆 Resultado pendente há ${data?.dias_aguardando || '?'}d: ${data?.title || ''}`,
    resultado_publicado: () => `✅ Resultado: ${data?.title || ''}`,
    new_order:           () => `Pedido: ${data?.product || ''} — R$${data?.value || ''}`,
    email_stats:         () => `Email: ${data?.sent || 0} enviados, ${data?.open_rate || 0}% abertura`,
    new_contact:         () => `Novo contato: ${data?.name || data?.email || ''}`,
    email_received:      () => `📧 De: ${data?.from || ''} — ${data?.subject || ''}`,
    daily_summary:       () => `${data?.abertos || 0} abertos, ${data?.aguardando || 0} aguardando, ${data?.novos_hoje || 0} novos hoje`,
    calendar_event:      () => `Evento: ${data?.title || ''}`,
    test:                () => `Teste: ${data?.msg || ''}`,
  };
  return (map[type] || (() => type))();
}
