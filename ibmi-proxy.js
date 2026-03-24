import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://rpglens.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Auth ─────────────────────────────────────────────────────────
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session expired.' });

    // ── Plan gate ────────────────────────────────────────────────────
    const plan = user.user_metadata?.plan || 'free';
    if (!['team', 'admin'].includes(plan)) {
      return res.status(403).json({ error: 'IBM i Connect requires the Team plan.', upgrade: true });
    }

    // ── Get connection config ────────────────────────────────────────
    const { data: conn } = await sb
      .from('ibmi_connections')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (!conn) return res.status(404).json({ error: 'No IBM i connection configured. Set up your connection first.' });

    const { endpoint, params, body, password } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint required.' });

    // ── Forward to agent ──────────────────────────────────────────────
    let result;
    if (conn.mode === 'direct') {
      result = await forwardDirect(conn, endpoint, params, body, password);
    } else {
      result = await forwardTunnel(conn, endpoint, params, body, password);
    }

    // Update last_seen
    sb.from('ibmi_connections')
      .update({ last_seen: new Date().toISOString(), is_active: true })
      .eq('user_id', user.id)
      .then(() => {}).catch(() => {});

    return res.status(200).json(result);

  } catch(err) {
    console.error('ibmi-proxy error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Proxy error' });
  }
}

async function forwardDirect(conn, endpoint, params, body, password) {
  const qstr = params ? '?' + new URLSearchParams(params).toString() : '';
  const url  = `http://${conn.hostname}:${conn.port}/${endpoint}${qstr}`;

  const resp = await fetchWithTimeout(url, {
    method:  body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-IBM-User':   conn.username,
      'X-IBM-Pass':   password || ''
    },
    body: body ? JSON.stringify(body) : undefined
  }, 30000);

  return await resp.json();
}

async function forwardTunnel(conn, endpoint, params, body, password) {
  const relayUrl = `${process.env.RELAY_URL || 'https://relay.rpglens.app'}/forward/${conn.tunnel_id}/${endpoint}`;

  const resp = await fetchWithTimeout(relayUrl, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Relay-Secret':  process.env.RELAY_SECRET || ''
    },
    body: JSON.stringify({
      params:   params   || {},
      body:     body     || {},
      user:     conn.username,
      password: password || ''
    })
  }, 35000);

  return await resp.json();
}

function fetchWithTimeout(url, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timed out')), timeoutMs);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}
