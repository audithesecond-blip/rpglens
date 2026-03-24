#!/usr/bin/env node
/**
 * RPGLens IBM i Agent
 * Single-file agent that runs in IBM i PASE
 * Supports both Direct mode (HTTP server) and Tunnel mode (WebSocket client)
 *
 * Usage:
 *   Direct mode:  node rpglens-agent.js --mode direct --port 3001 --user MYUSER --password MYPASS
 *   Tunnel mode:  node rpglens-agent.js --mode tunnel --tunnel-id YOUR_TUNNEL_ID --user MYUSER --password MYPASS --relay wss://relay.rpglens.app
 *
 * Requirements: Node.js 14+ in IBM i PASE (available V7R3+)
 * Install Node.js on IBM i: https://ibm.biz/ibmi-oss
 */

'use strict';

const http       = require('http');
const https      = require('https');
const { exec, execSync } = require('child_process');
const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');

// ── CLI args ──────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) args[arg.slice(2)] = arr[i + 1] || true;
});

const MODE       = args.mode      || 'direct';
const PORT       = parseInt(args.port || '3001');
const IBM_USER   = args.user      || process.env.RPGLENS_USER || '';
const IBM_PASS   = args.password  || process.env.RPGLENS_PASS || '';
const TUNNEL_ID  = args['tunnel-id'] || process.env.RPGLENS_TUNNEL_ID || '';
const RELAY_URL  = args.relay     || process.env.RPGLENS_RELAY || 'wss://relay.rpglens.app';
const AGENT_VER  = '1.0.0';

// ── Validate credentials by running a simple CL command ──────────────
function validateCredentials(user, pass) {
  try {
    // Use system() to test credentials — this will fail if user/pass wrong
    const result = execSync(
      `system "CHKPWD USRPRF(${user.toUpperCase()}) PASSWORD(${pass})"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
    );
    return true;
  } catch(e) {
    // CHKPWD returns non-zero if password is wrong
    return false;
  }
}

// ── Run a CL command and return output ───────────────────────────────
function runCL(cmd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    exec(`system "${cmd.replace(/"/g, '\\"')}"`, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout || '');
    });
  });
}

// ── Run SQL via db2 util ──────────────────────────────────────────────
function runSQL(sql) {
  return new Promise((resolve, reject) => {
    const cmd = `db2 "${sql.replace(/"/g, '\\"')}"`;
    exec(cmd, { timeout: 30000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(parseDb2Output(stdout || ''));
    });
  });
}

function parseDb2Output(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  // Find header line (contains column names separated by spaces)
  let headerIdx = lines.findIndex(l => l.match(/^[A-Z_]/) && !l.startsWith('DB2'));
  if (headerIdx === -1) return [];
  const headers = lines[headerIdx].split(/\s{2,}/).map(h => h.trim());
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (lines[i].match(/^\d+ record/)) break;
    const vals = lines[i].split(/\s{2,}/).map(v => v.trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return rows;
}

// ── API Handlers ──────────────────────────────────────────────────────
const handlers = {

  // Health check
  async ping(params) {
    return {
      status:  'ok',
      version: AGENT_VER,
      system:  os.hostname(),
      mode:    MODE,
      user:    IBM_USER,
      time:    new Date().toISOString()
    };
  },

  // List libraries user has access to
  async libraries(params) {
    const rows = await runSQL(
      "SELECT SCHEMA_NAME, SCHEMA_TEXT FROM QSYS2.SCHEMATA ORDER BY SCHEMA_NAME"
    );
    return { libraries: rows };
  },

  // List source physical files in a library
  async srcpfs(params) {
    const lib = (params.lib || 'QGPL').toUpperCase();
    const rows = await runSQL(
      `SELECT TABLE_NAME, TABLE_TEXT FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = '${lib}' AND FILE_TYPE = 'S' ORDER BY TABLE_NAME`
    );
    return { library: lib, srcpfs: rows };
  },

  // List members in a source file
  async members(params) {
    const lib = (params.lib || 'QGPL').toUpperCase();
    const spf = (params.spf || 'QRPGLESRC').toUpperCase();
    const rows = await runSQL(
      `SELECT SOURCE_FILE_MEMBER AS MBR, SOURCE_TYPE AS TYPE, SOURCE_MEMBER_TEXT AS TEXT, LAST_SOURCE_CHANGE_TIMESTAMP AS CHANGED FROM QSYS2.SYSPARTITIONSTAT WHERE TABLE_SCHEMA = '${lib}' AND TABLE_NAME = '${spf}' ORDER BY SOURCE_FILE_MEMBER`
    );
    return { library: lib, srcpf: spf, members: rows };
  },

  // Read source member content
  async source(params) {
    const lib = (params.lib || 'QGPL').toUpperCase();
    const spf = (params.spf || 'QRPGLESRC').toUpperCase();
    const mbr = (params.mbr || '').toUpperCase();
    if (!mbr) throw new Error('Member name required');

    // Use QSYS2.MEMBER_STATISTICS for metadata, then read via IFS or DSPF
    const rows = await runSQL(
      `SELECT SRCDTA FROM ${lib}.${spf} WHERE SRCMBR = '${mbr}' ORDER BY SRCSEQ`
    );
    const source = rows.map(r => r.SRCDTA || '').join('\n');
    return { library: lib, srcpf: spf, member: mbr, source, lines: rows.length };
  },

  // List active jobs
  async jobs(params) {
    const status = (params.status || 'ALL').toUpperCase();
    let where = "JOB_STATUS NOT IN ('OUTQ','COMPLETE')";
    if (status !== 'ALL') where = `JOB_STATUS = '${status}'`;

    const rows = await runSQL(
      `SELECT JOB_NAME, JOB_USER, JOB_TYPE, JOB_STATUS, FUNCTION_TYPE, FUNCTION, CPU_TIME, ELAPSED_TIME FROM QSYS2.ACTIVE_JOB_INFO WHERE ${where} ORDER BY JOB_STATUS, JOB_USER`
    );
    return { jobs: rows, count: rows.length, refreshed: new Date().toISOString() };
  },

  // List objects in a library
  async objects(params) {
    const lib  = (params.lib  || 'QGPL').toUpperCase();
    const type = (params.type || '*ALL').toUpperCase().replace('*', '');
    let where  = `OBJLIB = '${lib}'`;
    if (type !== 'ALL') where += ` AND OBJTYPE = '*${type}'`;

    const rows = await runSQL(
      `SELECT OBJNAME, OBJTYPE, OBJTEXT, OBJSIZE, LAST_USED_TIMESTAMP FROM QSYS2.OBJECT_STATISTICS WHERE ${where} ORDER BY OBJTYPE, OBJNAME`
    );
    return { library: lib, type: params.type || '*ALL', objects: rows };
  },

  // Validate IBM i credentials
  async auth(params, body) {
    const user = (body.user || '').toUpperCase();
    const pass = body.password || '';
    if (!user || !pass) throw new Error('User and password required');
    const valid = validateCredentials(user, pass);
    if (!valid) throw new Error('Invalid IBM i credentials');
    return { authenticated: true, user };
  }
};

// ── Request dispatcher ────────────────────────────────────────────────
async function dispatch(endpoint, params, body, authUser, authPass) {
  // Validate credentials on every request
  if (authUser && authPass) {
    const valid = validateCredentials(authUser, authPass);
    if (!valid) throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  } else {
    throw Object.assign(new Error('Credentials required'), { status: 401 });
  }

  const handler = handlers[endpoint];
  if (!handler) throw Object.assign(new Error(`Unknown endpoint: ${endpoint}`), { status: 404 });
  return await handler(params, body || {});
}

// ── DIRECT MODE: HTTP Server ──────────────────────────────────────────
function startDirectMode() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-IBM-User, X-IBM-Pass');

    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    const parsed   = url.parse(req.url, true);
    const endpoint = parsed.pathname.replace(/^\//, '');
    const params   = parsed.query;
    const authUser = req.headers['x-ibm-user'] || '';
    const authPass = req.headers['x-ibm-pass'] || '';

    let body = {};
    if (req.method === 'POST') {
      const raw = await new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); });
      try { body = JSON.parse(raw); } catch(e) {}
    }

    try {
      const result = await dispatch(endpoint, params, body, authUser, authPass);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data: result }));
    } catch(e) {
      res.writeHead(e.status || 500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RPGLens Agent v${AGENT_VER} running in DIRECT mode on port ${PORT}`);
    console.log(`IBM i user: ${IBM_USER}`);
  });
}

// ── TUNNEL MODE: WebSocket client ─────────────────────────────────────
function startTunnelMode() {
  if (!TUNNEL_ID) {
    console.error('Tunnel mode requires --tunnel-id. Generate one in your RPGLens dashboard.');
    process.exit(1);
  }

  let ws = null;
  let reconnectTimer = null;

  function connect() {
    console.log(`Connecting to relay: ${RELAY_URL}`);

    // Dynamic require for ws — install with: npm install ws
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch(e) {
      console.error('WebSocket library not found. Run: npm install ws');
      process.exit(1);
    }

    ws = new WebSocket(`${RELAY_URL}?tunnel_id=${TUNNEL_ID}&agent_version=${AGENT_VER}`);

    ws.on('open', () => {
      console.log(`RPGLens Agent v${AGENT_VER} connected in TUNNEL mode`);
      console.log(`Tunnel ID: ${TUNNEL_ID}`);
      // Send registration
      ws.send(JSON.stringify({ type: 'register', tunnel_id: TUNNEL_ID, version: AGENT_VER, system: os.hostname() }));
    });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch(e) { return; }

      if (msg.type === 'request') {
        const { req_id, endpoint, params, body, user, password } = msg;
        try {
          const result = await dispatch(endpoint, params || {}, body || {}, user, password);
          ws.send(JSON.stringify({ type: 'response', req_id, ok: true, data: result }));
        } catch(e) {
          ws.send(JSON.stringify({ type: 'response', req_id, ok: false, error: e.message }));
        }
      }
    });

    ws.on('close', () => {
      console.log('Disconnected from relay. Reconnecting in 5s...');
      reconnectTimer = setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  }

  connect();
}

// ── Startup ───────────────────────────────────────────────────────────
console.log('');
console.log('  ╔═══════════════════════════════╗');
console.log('  ║  RPGLens IBM i Agent v' + AGENT_VER + '    ║');
console.log('  ╚═══════════════════════════════╝');
console.log('');

if (!IBM_USER) {
  console.error('Error: IBM i user required. Use --user MYUSER');
  process.exit(1);
}

if (MODE === 'tunnel') {
  startTunnelMode();
} else {
  startDirectMode();
}
