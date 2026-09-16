'use strict';
/*
 * NexCore backend. Zero npm dependencies on purpose — this is meant to be
 * cloned onto a homelab box and run with just `node backend/server.js`,
 * no install step, no internet access required to get it running.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');

const users = require('./users/users');
const auth = require('./auth/auth');
const files = require('./api/files');
const { enforceUploadCap, checkArchiveSafety, LIMITS, formatBytes } = require('./api/archiveGuard');

const PORT_EXPLICIT = !!process.env.PORT;
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PORT_FALLBACK_ATTEMPTS = 5; // only used when PORT_EXPLICIT is false
const FRONTEND_ROOT = path.join(__dirname, '..', 'frontend');

const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon'
};

// Raster image types only — no image/svg+xml. SVGs can embed <script> and
// would run it in our origin if ever rendered inline; these formats can't.
const INLINE_SAFE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'
]);

function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJSONBody(req, maxBytes = 1024 * 1024){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if(size > maxBytes){
        req.destroy();
        reject(Object.assign(new Error('Body too large.'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if(chunks.length === 0) return resolve({});
      try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e){ reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function requireUser(req, res){
  const user = auth.getSessionUser(req);
  if(!user){
    sendJSON(res, 401, { error: 'Not signed in.' });
    return null;
  }
  return user;
}

async function handleApi(req, res, parsed){
  const segments = parsed.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, group, sub, param] = segments;

  // ---- auth ----
  if(group === 'auth'){
    if(sub === 'signup' && req.method === 'POST'){
      const body = await readJSONBody(req);
      const user = users.createUser(body.email || '', body.password || '');
      const token = auth.createSession(user.id);
      auth.setSessionCookie(res, token);
      return sendJSON(res, 200, { email: user.email });
    }
    if(sub === 'login' && req.method === 'POST'){
      const body = await readJSONBody(req);
      const user = users.authenticate(body.email || '', body.password || '');
      const token = auth.createSession(user.id);
      auth.setSessionCookie(res, token);
      return sendJSON(res, 200, { email: user.email });
    }
    if(sub === 'logout' && req.method === 'POST'){
      const cookies = auth.parseCookies(req);
      const token = cookies[auth.SESSION_COOKIE];
      if(token) auth.destroySession(token);
      auth.clearSessionCookie(res);
      return sendJSON(res, 200, { ok: true });
    }
    if(sub === 'me' && req.method === 'GET'){
      const user = auth.getSessionUser(req);
      return sendJSON(res, 200, { email: user ? user.email : null });
    }
  }

  // ---- files ----
  if(group === 'files'){
    const user = requireUser(req, res);
    if(!user) return;

    if(!sub && req.method === 'GET'){
      const parentId = parsed.query.parentId || null;
      return sendJSON(res, 200, { items: files.listChildren(user.id, parentId) });
    }

    if(sub === 'search' && req.method === 'GET'){
      const q = parsed.query.q || '';
      return sendJSON(res, 200, { items: files.searchNodes(user.id, q) });
    }

    if(sub === 'folder' && req.method === 'POST'){
      const body = await readJSONBody(req);
      const node = files.createFolder(user.id, body.parentId || null, body.name || '');
      return sendJSON(res, 200, node);
    }

    if(sub === 'upload' && req.method === 'POST'){
      const parentId = parsed.query.parentId || null;
      const name = decodeURIComponent(parsed.query.name || 'untitled');
      const mime = decodeURIComponent(parsed.query.mime || '');

      const currentUsage = files.usageBytes(user.id);
      const tempPath = files.newTempPath();

      let capResult;
      try{
        capResult = await enforceUploadCap(req, tempPath, LIMITS.MAX_UPLOAD_BYTES);
      }catch(e){
        if(e.code === 'LIMIT_EXCEEDED') return sendJSON(res, 413, { error: e.message });
        return sendJSON(res, 400, { error: 'Upload failed.' });
      }

      if(currentUsage + capResult.bytesWritten > user.quotaBytes){
        await fs.promises.rm(tempPath, { force:true });
        return sendJSON(res, 400, { error: `This would exceed your ${formatBytes(user.quotaBytes)} quota.` });
      }

      const verdict = await checkArchiveSafety(tempPath);
      if(!verdict.safe){
        await fs.promises.rm(tempPath, { force:true });
        return sendJSON(res, 400, { error: verdict.reason });
      }

      try{
        const node = files.commitUploadedFile({
          ownerId: user.id, parentId, name, mime, size: capResult.bytesWritten, tempPath
        });
        return sendJSON(res, 200, node);
      }catch(e){
        await fs.promises.rm(tempPath, { force:true });
        throw e;
      }
    }

    if(sub === 'download' && param && req.method === 'GET'){
      const node = files.getNode(param);
      files.assertOwned(node, user.id);
      if(node.type !== 'file') return sendJSON(res, 400, { error: 'Not a file.' });
      const diskPath = files.filePathOnDisk(node);
      res.writeHead(200, {
        'Content-Type': node.mime || 'application/octet-stream',
        'Content-Length': node.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(node.name)}"`
      });
      fs.createReadStream(diskPath).pipe(res);
      return;
    }

    // Inline preview, for images only. Deliberately NOT used for arbitrary
    // file types: serving a file with Content-Disposition: inline lets the
    // browser render it in the page rather than download it, which is
    // exactly what you don't want for something like an uploaded SVG or
    // HTML file — those can carry <script> and would execute it in our
    // origin (with the signed-in user's cookies) if ever opened directly.
    // Raster formats here can't carry executable script, so they're safe
    // to render inline; everything else falls back to a normal download.
    if(sub === 'view' && param && req.method === 'GET'){
      const node = files.getNode(param);
      files.assertOwned(node, user.id);
      if(node.type !== 'file') return sendJSON(res, 400, { error: 'Not a file.' });
      if(!INLINE_SAFE_MIME_TYPES.has(node.mime)){
        return sendJSON(res, 415, { error: 'This file type can\u2019t be previewed inline.' });
      }
      const diskPath = files.filePathOnDisk(node);
      res.writeHead(200, {
        'Content-Type': node.mime,
        'Content-Length': node.size,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff'
      });
      fs.createReadStream(diskPath).pipe(res);
      return;
    }

    // /api/files/:id (rename / delete) — anything in the `sub` slot that
    // isn't one of the known action words above is treated as a node id.
    if(sub && !['folder', 'upload', 'download', 'view', 'search'].includes(sub)){
      const id = sub;
      if(req.method === 'PATCH'){
        const body = await readJSONBody(req);
        const node = files.renameNode(id, user.id, body.name || '');
        return sendJSON(res, 200, node);
      }
      if(req.method === 'DELETE'){
        files.deleteNodeCascade(id, user.id);
        return sendJSON(res, 200, { ok: true });
      }
    }
  }

  // ---- storage ----
  if(group === 'storage' && sub === 'usage' && req.method === 'GET'){
    const user = requireUser(req, res);
    if(!user) return;
    return sendJSON(res, 200, { used: files.usageBytes(user.id), quota: user.quotaBytes });
  }

  sendJSON(res, 404, { error: 'Unknown API route.' });
}

function serveStatic(req, res, pathname){
  let rel = pathname === '/' ? '/login/index.html' : pathname;
  let filePath = path.join(FRONTEND_ROOT, rel);

  // If it's a directory-style route with no extension, try its index.html.
  if(!path.extname(filePath)){
    filePath = path.join(filePath, 'index.html');
  }

  // Prevent path traversal outside frontend/.
  if(!filePath.startsWith(FRONTEND_ROOT)){
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if(parsed.pathname.startsWith('/api/')){
    try{
      await handleApi(req, res, parsed);
    }catch(e){
      const status = e.status || 500;
      if(status === 500) console.error(e);
      if(!res.headersSent) sendJSON(res, status, { error: e.message || 'Server error.' });
    }
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

/**
 * Every network your phone/PC's wifi connects to can hand out a
 * different local IP, and reconnecting to the SAME network can too
 * (DHCP lease changes). Rather than printing a placeholder and making
 * you go hunt for the address yourself, detect and print whatever it
 * actually is right now, every time the server starts.
 */
function getLanAddresses(){
  const nets = os.networkInterfaces();
  const out = [];
  for(const ifaceName of Object.keys(nets)){
    for(const net of nets[ifaceName] || []){
      if(net.family === 'IPv4' && !net.internal){
        out.push({ iface: ifaceName, address: net.address });
      }
    }
  }
  return out;
}

function printStartupBanner(boundPort){
  console.log(`NexCore running.`);
  console.log(`  On this machine:  http://localhost:${boundPort}`);
  const lan = getLanAddresses();
  if(lan.length === 0){
    console.log(`  No LAN network interface detected — only reachable from this machine right now.`);
  } else {
    for(const { iface, address } of lan){
      console.log(`  On your LAN:      http://${address}:${boundPort}  (${iface})`);
    }
    console.log(`  Reconnecting to wifi can change this address — re-run this and check again if a bookmarked link stops working.`);
  }
}

function startListening(port, attemptsLeft){
  server.removeAllListeners('error');
  server.removeAllListeners('listening');

  server.once('error', (err) => {
    if(err.code === 'EADDRINUSE'){
      if(!PORT_EXPLICIT && attemptsLeft > 0){
        console.log(`Port ${port} is already in use, trying ${port + 1}...`);
        setTimeout(() => startListening(port + 1, attemptsLeft - 1), 150);
        return;
      }
      console.error(`\nPort ${port} is already in use.`);
      if(PORT_EXPLICIT){
        console.error(`You set PORT=${port} explicitly, so nothing was auto-retried. Either free that port or pick a different one, e.g.:\n  PORT=${port + 1} node backend/server.js`);
      } else {
        console.error(`Tried ports ${PORT}\u2013${port}, all in use. Free one of them or set PORT explicitly:\n  PORT=9000 node backend/server.js`);
      }
      process.exit(1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.once('listening', () => printStartupBanner(port));
  server.listen(port, HOST);
}

startListening(PORT, MAX_PORT_FALLBACK_ATTEMPTS);

module.exports = server;
