'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { checkArchiveSafety, enforceUploadCap, LIMITS } = require('../backend/api/archiveGuard');

const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

// Minimal CRC32 (standard poly), good enough for a valid test zip.
function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for(let i = 0; i < buf.length; i++){
    c = (crc ^ buf[i]) & 0xFF;
    for(let k = 0; k < 8; k++){
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries){
  // entries: [{ name, data (Buffer, raw uncompressed) }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for(const entry of entries){
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);   // version needed
    local.writeUInt16LE(0, 6);    // flags
    local.writeUInt16LE(8, 8);    // method = deflate
    local.writeUInt16LE(0, 10);   // time
    local.writeUInt16LE(0, 12);   // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

async function main(){
  let failures = 0;
  function check(label, cond){
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
    if(!cond) failures++;
  }

  // 1. Normal small zip: one text file, should be SAFE.
  const normalZip = buildZip([{ name: 'hello.txt', data: Buffer.from('Hello, NexCore! '.repeat(50)) }]);
  const normalPath = path.join(TMP, 'normal.zip');
  fs.writeFileSync(normalPath, normalZip);
  const normalResult = await checkArchiveSafety(normalPath);
  check('normal zip is allowed', normalResult.safe === true);

  // 2. Real zip bomb: one entry of 300MB of zero bytes (compresses to a few KB).
  const bombData = Buffer.alloc(300 * 1024 * 1024); // 300MB of zeros
  const bombZip = buildZip([{ name: 'zeros.bin', data: bombData }]);
  const bombPath = path.join(TMP, 'bomb.zip');
  fs.writeFileSync(bombPath, bombZip);
  console.log('bomb.zip on-disk size:', bombZip.length, 'bytes; true uncompressed:', bombData.length);
  const bombResult = await checkArchiveSafety(bombPath);
  check('zip bomb is blocked', bombResult.safe === false);
  if(!bombResult.safe) console.log('  reason:', bombResult.reason);

  // 3. Fake zip64 sentinel forcing fail-closed behavior.
  const zip64Bomb = Buffer.from(normalZip); // clone
  // Corrupt the central-directory entry count in EOCD to 0xFFFF to simulate zip64 signal.
  const eocdSigOffset = zip64Bomb.length - 22;
  zip64Bomb.writeUInt16LE(0xffff, eocdSigOffset + 10);
  const zip64Path = path.join(TMP, 'zip64ish.zip');
  fs.writeFileSync(zip64Path, zip64Bomb);
  const zip64Result = await checkArchiveSafety(zip64Path);
  check('zip64-flagged file fails closed (blocked)', zip64Result.safe === false);

  // 4. Non-archive plain file should be allowed regardless of content.
  const plainPath = path.join(TMP, 'plain.txt');
  fs.writeFileSync(plainPath, 'just a normal text file'.repeat(1000));
  const plainResult = await checkArchiveSafety(plainPath);
  check('plain non-archive file is allowed', plainResult.safe === true);

  // 5. Streaming cap: simulate a fake "req" stream pushing more than the cap.
  const { PassThrough } = require('stream');
  const fakeReq = new PassThrough();
  const capPath = path.join(TMP, 'capped.bin');
  const smallCap = 1024 * 1024; // 1MB cap for the test
  const capPromise = enforceUploadCap(fakeReq, capPath, smallCap);
  const chunk = Buffer.alloc(256 * 1024, 1); // 256KB chunks
  let pushed = 0;
  const pushInterval = setInterval(() => {
    fakeReq.write(chunk);
    pushed += chunk.length;
    if(pushed > smallCap * 3){
      clearInterval(pushInterval);
      fakeReq.end();
    }
  }, 0);
  let capRejected = false;
  try{
    await capPromise;
  }catch(e){
    capRejected = (e.code === 'LIMIT_EXCEEDED');
  }
  check('oversized stream is aborted before fully buffered', capRejected);
  check('capped temp file was cleaned up', !fs.existsSync(capPath));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
