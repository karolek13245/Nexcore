'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for(let i = 0; i < buf.length; i++){
    c = (crc ^ buf[i]) & 0xFF;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(entries){
  const localParts = [], centralParts = [];
  let offset = 0;
  for(const entry of entries){
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6);
    local.writeUInt16LE(8,8); local.writeUInt16LE(0,10); local.writeUInt16LE(0,12);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(entry.data.length,22);
    local.writeUInt16LE(nameBuf.length,26); local.writeUInt16LE(0,28);
    localParts.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6);
    central.writeUInt16LE(0,8); central.writeUInt16LE(8,10); central.writeUInt16LE(0,12); central.writeUInt16LE(0,14);
    central.writeUInt32LE(crc,16); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(entry.data.length,24);
    central.writeUInt16LE(nameBuf.length,28); central.writeUInt16LE(0,30); central.writeUInt16LE(0,32);
    central.writeUInt16LE(0,34); central.writeUInt16LE(0,36); central.writeUInt32LE(0,38); central.writeUInt32LE(offset,42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(entries.length,8); eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(centralSection.length,12); eocd.writeUInt32LE(localSection.length,16); eocd.writeUInt16LE(0,20);
  return Buffer.concat([localSection, centralSection, eocd]);
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function main(){
  // Clean slate for a repeatable test run.
  const dataDir = path.join(ROOT, 'backend', 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const storageDir = path.join(ROOT, 'storage', 'files');
  fs.rmSync(storageDir, { recursive: true, force: true });

  const proc = spawn('node', ['backend/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[server-err] ' + d));

  let failures = 0;
  function check(label, cond, extra){
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
    if(!cond) failures++;
  }

  try{
    await sleep(500); // let it bind

    const email = `tester_${Date.now()}@example.com`;
    const password = 'correct-horse-battery';

    // --- signup ---
    let res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ email, password })
    });
    const setCookie = res.headers.get('set-cookie');
    check('signup succeeds', res.status === 200, await res.clone().text());
    check('signup sets a session cookie', !!setCookie && setCookie.includes('nexcore_session'));
    const cookie = setCookie ? setCookie.split(';')[0] : '';

    // --- duplicate signup rejected ---
    res = await fetch(`${BASE}/api/auth/signup`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password })
    });
    check('duplicate signup rejected (409)', res.status === 409);

    // --- me ---
    res = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
    const me = await res.json();
    check('me reflects signed-in user', me.email === email.toLowerCase());

    // --- wrong password login rejected ---
    res = await fetch(`${BASE}/api/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password: 'wrong-password-here' })
    });
    check('wrong password rejected (401)', res.status === 401);

    // --- create folder ---
    res = await fetch(`${BASE}/api/files/folder`, {
      method:'POST', headers:{'Content-Type':'application/json', Cookie: cookie},
      body: JSON.stringify({ name: 'Photos', parentId: null })
    });
    const folder = await res.json();
    check('folder created', res.status === 200 && folder.type === 'folder', JSON.stringify(folder));

    // --- upload normal file into folder ---
    const normalContent = Buffer.from('Just a normal file. '.repeat(1000));
    res = await fetch(`${BASE}/api/files/upload?parentId=${folder.id}&name=${encodeURIComponent('notes.txt')}&mime=text/plain`, {
      method:'POST', headers:{ Cookie: cookie, 'Content-Type':'application/octet-stream' },
      body: normalContent
    });
    const normalNode = await res.json();
    check('normal file upload succeeds', res.status === 200 && normalNode.size === normalContent.length, JSON.stringify(normalNode));

    // --- list folder contents ---
    res = await fetch(`${BASE}/api/files?parentId=${folder.id}`, { headers: { Cookie: cookie } });
    const listing = await res.json();
    check('folder listing shows uploaded file', listing.items.some(i => i.id === normalNode.id));

    // --- download it back and verify bytes match ---
    res = await fetch(`${BASE}/api/files/download/${normalNode.id}`, { headers: { Cookie: cookie } });
    const downloaded = Buffer.from(await res.arrayBuffer());
    check('downloaded bytes match uploaded bytes', downloaded.equals(normalContent));

    // --- upload a REAL zip bomb (300MB of zeros, ~300KB on disk) ---
    const bombData = Buffer.alloc(300 * 1024 * 1024);
    const bombZip = buildZip([{ name: 'zeros.bin', data: bombData }]);
    const t0 = Date.now();
    res = await fetch(`${BASE}/api/files/upload?parentId=&name=${encodeURIComponent('totally-a-photo.zip')}&mime=application/zip`, {
      method:'POST', headers:{ Cookie: cookie, 'Content-Type':'application/octet-stream' },
      body: bombZip
    });
    const bombResult = await res.json();
    const elapsedMs = Date.now() - t0;
    check('zip bomb upload rejected (400)', res.status === 400, JSON.stringify(bombResult));
    check('server responded quickly, not hung', elapsedMs < 5000, `${elapsedMs}ms`);
    console.log('  bomb rejection reason:', bombResult.error);

    // --- confirm the bomb was NOT saved anywhere on disk ---
    const filesOnDisk = fs.existsSync(storageDir) ? fs.readdirSync(storageDir, { recursive: true }) : [];
    const totalOnDiskBytes = filesOnDisk
      .map(f => path.join(storageDir, f))
      .filter(p => fs.existsSync(p) && fs.statSync(p).isFile())
      .reduce((sum, p) => sum + fs.statSync(p).size, 0);
    check('no 300MB blob persisted to disk', totalOnDiskBytes < 10 * 1024 * 1024, `${totalOnDiskBytes} bytes on disk`);
    const tmpLeftover = fs.readdirSync(path.join(dataDir, 'tmp')).length;
    check('temp upload file was cleaned up', tmpLeftover === 0, `${tmpLeftover} leftover temp files`);

    // --- oversized (non-archive) upload also rejected by the streaming cap ---
    // (use a smaller synthetic check against the real 2GB cap would be slow; instead
    //  confirm the cap constant is enforced by uploading something declared-huge via
    //  a custom tiny cap isn't exposed over HTTP, so we trust the unit test for this
    //  path and only sanity check normal-size behavior end-to-end here.)

    // --- search ---
    res = await fetch(`${BASE}/api/files/folder`, {
      method:'POST', headers:{'Content-Type':'application/json', Cookie: cookie},
      body: JSON.stringify({ name: 'Receipts', parentId: folder.id })
    });
    const subFolder = await res.json();
    res = await fetch(`${BASE}/api/files/upload?parentId=${subFolder.id}&name=${encodeURIComponent('invoice-march.txt')}&mime=text/plain`, {
      method:'POST', headers:{ Cookie: cookie, 'Content-Type':'application/octet-stream' },
      body: Buffer.from('march invoice contents')
    });
    const deepFile = await res.json();

    res = await fetch(`${BASE}/api/files/search?q=invoice`, { headers: { Cookie: cookie } });
    const searchResult = await res.json();
    check('search finds nested file by substring', searchResult.items.some(i => i.id === deepFile.id), JSON.stringify(searchResult));
    const found = searchResult.items.find(i => i.id === deepFile.id);
    check('search result includes correct ancestor path', found && found.path.map(p=>p.name).join('/') === 'Photos/Receipts', JSON.stringify(found && found.path));

    res = await fetch(`${BASE}/api/files/search?q=zzz_nomatch_zzz`, { headers: { Cookie: cookie } });
    const noMatch = await res.json();
    check('search with no matches returns empty array', Array.isArray(noMatch.items) && noMatch.items.length === 0);

    res = await fetch(`${BASE}/api/files/search?q=INVOICE`, { headers: { Cookie: cookie } });
    const caseInsensitive = await res.json();
    check('search is case-insensitive', caseInsensitive.items.some(i => i.id === deepFile.id));

    // --- inline view endpoint: image preview ---
    // Fake PNG bytes (real signature header) so mime/type checks feel realistic.
    const fakePngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not a real png body but that is fine for this test')
    ]);
    res = await fetch(`${BASE}/api/files/upload?parentId=&name=${encodeURIComponent('photo.png')}&mime=image/png`, {
      method:'POST', headers:{ Cookie: cookie, 'Content-Type':'application/octet-stream' },
      body: fakePngBytes
    });
    const pngNode = await res.json();
    res = await fetch(`${BASE}/api/files/view/${pngNode.id}`, { headers: { Cookie: cookie } });
    check('image view endpoint returns 200 with inline disposition', res.status === 200 && res.headers.get('content-disposition') === 'inline', `status=${res.status} disp=${res.headers.get('content-disposition')}`);
    check('image view sets nosniff header', res.headers.get('x-content-type-options') === 'nosniff');
    const viewedBytes = Buffer.from(await res.arrayBuffer());
    check('image view returns correct bytes', viewedBytes.equals(fakePngBytes));

    // SVG must NOT be inline-viewable (script-execution risk), even though it's an "image" mime family.
    res = await fetch(`${BASE}/api/files/upload?parentId=&name=${encodeURIComponent('evil.svg')}&mime=image/svg+xml`, {
      method:'POST', headers:{ Cookie: cookie, 'Content-Type':'application/octet-stream' },
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    });
    const svgNode = await res.json();
    res = await fetch(`${BASE}/api/files/view/${svgNode.id}`, { headers: { Cookie: cookie } });
    check('SVG is rejected by the inline-view whitelist (415)', res.status === 415, `status=${res.status}`);

    // A plain text file also shouldn't be inline-viewable.
    res = await fetch(`${BASE}/api/files/view/${normalNode.id}`, { headers: { Cookie: cookie } });
    check('non-image file is rejected by the inline-view whitelist (415)', res.status === 415, `status=${res.status}`);

    // --- rename ---
    res = await fetch(`${BASE}/api/files/${normalNode.id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json', Cookie: cookie},
      body: JSON.stringify({ name: 'renamed.txt' })
    });
    const renamed = await res.json();
    check('rename works', renamed.name === 'renamed.txt', `status=${res.status} body=${JSON.stringify(renamed)}`);

    // --- delete folder cascades ---
    res = await fetch(`${BASE}/api/files/${folder.id}`, { method:'DELETE', headers:{ Cookie: cookie } });
    const deleteBody = await res.clone().text();
    check('folder delete succeeds', res.status === 200, `status=${res.status} body=${deleteBody}`);
    res = await fetch(`${BASE}/api/files?parentId=${folder.id}`, { headers: { Cookie: cookie } });
    const afterDelete = await res.json();
    check('deleted folder is empty/gone', afterDelete.items.length === 0, JSON.stringify(afterDelete));

    // --- logout then verify session is dead ---
    res = await fetch(`${BASE}/api/auth/logout`, { method:'POST', headers:{ Cookie: cookie } });
    check('logout succeeds', res.status === 200);
    res = await fetch(`${BASE}/api/files?parentId=`, { headers: { Cookie: cookie } });
    check('old session cookie no longer works', res.status === 401);

    // --- static frontend serving ---
    res = await fetch(`${BASE}/`);
    const rootBody = await res.text();
    check('root serves login page', res.status === 200 && rootBody.includes('<html'), `status=${res.status} len=${rootBody.length} start=${rootBody.slice(0,80)}`);

    console.log(failures === 0 ? '\nALL INTEGRATION TESTS PASSED' : `\n${failures} INTEGRATION TEST(S) FAILED`);
  }finally{
    proc.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
