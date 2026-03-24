import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://rpglens.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Auth ─────────────────────────────────────────────────────────
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session expired.' });

    // ── Plan gate: Team + Admin only ─────────────────────────────────
    const plan = user.user_metadata?.plan || 'free';
    if (!['team', 'admin'].includes(plan)) {
      return res.status(403).json({
        error: 'IBM i Connect is available on the Team plan and above.',
        upgrade: true
      });
    }

    // ── GET: fetch saved connection ──────────────────────────────────
    if (req.method === 'GET') {
      const { data } = await sb
        .from('ibmi_connections')
        .select('id, name, mode, hostname, port, username, tunnel_id, is_active, last_seen, source_locations')
        .eq('user_id', user.id)
        .single();
      return res.status(200).json({ connection: data || null });
    }

    // ── DELETE: remove connection ────────────────────────────────────
    if (req.method === 'DELETE') {
      await sb.from('ibmi_connections').delete().eq('user_id', user.id);
      return res.status(200).json({ success: true });
    }

    // ── POST: save + test connection ─────────────────────────────────
    const { action, connection } = req.body;

    if (action === 'save') {
      const { mode, name, hostname, port, username, password, source_locations } = connection;

      if (!mode || !username) return res.status(400).json({ error: 'Mode and username required.' });
      if (mode === 'direct' && !hostname) return res.status(400).json({ error: 'Hostname required for direct mode.' });

      // Generate tunnel ID for tunnel mode
      let tunnelId = connection.tunnel_id;
      if (mode === 'tunnel' && !tunnelId) {
        tunnelId = `rpglens_${user.id.replace(/-/g,'').slice(0,12)}_${crypto.randomBytes(4).toString('hex')}`;
      }

      await sb.from('ibmi_connections').upsert({
        user_id:          user.id,
        name:             name || 'My IBM i',
        mode,
        hostname:         hostname || null,
        port:             parseInt(port || '3001'),
        username:         username.toUpperCase(),
        tunnel_id:        tunnelId || null,
        source_locations: source_locations || [],
        updated_at:       new Date().toISOString()
      }, { onConflict: 'user_id' });

      return res.status(200).json({ success: true, tunnel_id: tunnelId });
    }

    if (action === 'test') {
      const { mode, hostname, port, username, password } = connection;
      const testResult = await testConnection({ mode, hostname, port, username, password }, user.id);

      // Update last_seen if successful
      if (testResult.ok) {
        await sb.from('ibmi_connections')
          .update({ is_active: true, last_seen: new Date().toISOString() })
          .eq('user_id', user.id);
      }

      return res.status(200).json(testResult);
    }

    if (action === 'update_sources') {
      const { source_locations } = connection;
      await sb.from('ibmi_connections')
        .update({ source_locations, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action.' });

  } catch(err) {
    console.error('ibmi-connect error:', err);
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
}

async function testConnection({ mode, hostname, port, username, password, tunnel_id }, userId) {
  try {
    if (mode === 'direct') {
      const agentUrl = `http://${hostname}:${port || 3001}/ping`;
      const resp = await fetchWithTimeout(agentUrl, {
        method: 'GET',
        headers: {
          'X-IBM-User': username,
          'X-IBM-Pass': password || ''
        }
      }, 10000);
      const data = await resp.json();
      if (!data.ok) return { ok: false, error: data.error || 'Agent returned error' };
      return { ok: true, system: data.data?.system, version: data.data?.version };
    }

    if (mode === 'tunnel') {
      const tid = tunnel_id || `rpglens_${userId.replace(/-/g,'').slice(0,12)}`;
      const relayUrl = `${process.env.RELAY_URL || 'https://relay.rpglens.app'}/forward/${tid}/ping`;
      const resp = await fetchWithTimeout(relayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Secret': process.env.RELAY_SECRET || ''
        },
        body: JSON.stringify({ user: username, password: password || '', params: {}, body: {} })
      }, 15000);
      const data = await resp.json();
      if (!data.ok) return { ok: false, error: data.error || 'Tunnel connection failed' };
      return { ok: true, system: data.data?.system, version: data.data?.version };
    }

    return { ok: false, error: 'Invalid mode' };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

function fetchWithTimeout(url, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timed out after ' + (timeoutMs/1000) + 's')), timeoutMs);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}
