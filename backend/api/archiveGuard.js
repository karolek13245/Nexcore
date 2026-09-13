'use strict';
const fs = require('fs');

/*
 * ---------------------------------------------------------------------
 * Two independent layers of defense against a malicious upload, because
 * either one alone is not enough:
 *
 *  1. STREAMING SIZE CAP (enforceUploadCap, used by the HTTP handler)
 *     While bytes are still arriving off the socket, we count them as
 *     they're written to a temp file on disk and abort the instant the
 *     count exceeds MAX_UPLOAD_BYTES — before the whole body is ever
 *     buffered in memory. This is what actually stops a server from
 *     being crashed or OOM'd by a huge upload, decompression bomb or
 *     not: we never trust a Content-Length header, and we never hold
 *     the full body in RAM.
 *
 *  2. ARCHIVE METADATA CHECK (checkArchiveSafety, run only after the
 *     capped file is fully and safely on disk)
 *     For zip/gzip files specifically, we read only their own directory
 *     metadata (a few KB) to see what they CLAIM they'll expand to, and
 *     reject anything with an absurd compression ratio. We never
 *     decompress anything to check it — that would reintroduce the
 *     exact hang/crash risk we're defending against.
 *
 * Neither layer is a silicon bullet on its own: the size cap won't catch
 * a zip that's small on disk but expands to gigabytes once actually
 * unzipped by whatever eventually reads it (that's what layer 2 is for),
 * and the metadata check trusts the archive's own directory, which is
 * exactly why we fail CLOSED (reject) whenever something looks
 * ambiguous or unparseable (e.g. Zip64) rather than guessing it's fine.
 * ------------------------------------------------------------------- */

const LIMITS = {
  MAX_UPLOAD_BYTES: 2 * 1024 ** 3,       // 2 GB per file
  MAX_RATIO: 150,                         // declared-uncompressed / on-disk
  MAX_SINGLE_ENTRY_UNCOMPRESSED: 5 * 1024 ** 3,
  MAX_TOTAL_UNCOMPRESSED: 10 * 1024 ** 3,
};

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

function formatBytes(n){
  if(n < 1024) return n + ' B';
  const units = ['KB','MB','GB','TB'];
  let u = -1;
  do{ n /= 1024; u++; } while(n >= 1024 && u < units.length-1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[u];
}

/**
 * Stream a request body to a temp file, aborting the instant it exceeds
 * maxBytes. Resolves { bytesWritten } on success, rejects with
 * err.code === 'LIMIT_EXCEEDED' if the cap is hit, so the caller can
 * respond 413 without ever having buffered the oversized body.
 */
function enforceUploadCap(req, destPath, maxBytes = LIMITS.MAX_UPLOAD_BYTES){
  return new Promise((resolve, reject) => {
    let bytesWritten = 0;
    let aborted = false;
    const out = fs.createWriteStream(destPath);

    function cleanupAndReject(err){
      if(aborted) return;
      aborted = true;
      req.unpipe(out);
      req.destroy();
      out.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    }

    req.on('data', (chunk) => {
      if(aborted) return;
      bytesWritten += chunk.length;
      if(bytesWritten > maxBytes){
        const err = new Error(`Upload exceeds the ${formatBytes(maxBytes)} limit.`);
        err.code = 'LIMIT_EXCEEDED';
        cleanupAndReject(err);
      }
    });
    req.on('error', cleanupAndReject);
    out.on('error', cleanupAndReject);
    out.on('finish', () => {
      if(!aborted) resolve({ bytesWritten });
    });

    req.pipe(out);
  });
}

async function readRange(handle, start, length){
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, start);
  return buf.subarray(0, bytesRead);
}

async function looksLikeZip(handle, size){
  if(size < 4) return false;
  const buf = await readRange(handle, 0, 4);
  const sig = buf.readUInt32LE(0);
  return sig === ZIP_LOCAL_SIG || sig === ZIP_EOCD_SIG;
}
async function looksLikeGzip(handle, size){
  if(size < 2) return false;
  const buf = await readRange(handle, 0, 2);
  return buf[0] === 0x1f && buf[1] === 0x8b;
}

async function inspectZip(handle, size){
  const tailWindow = Math.min(size, 22 + 65557);
  const tail = await readRange(handle, size - tailWindow, tailWindow);

  let eocdPos = -1;
  for(let i = tail.length - 22; i >= 0; i--){
    if(tail.readUInt32LE(i) === ZIP_EOCD_SIG){ eocdPos = i; break; }
  }
  if(eocdPos === -1){
    return { safe:false, reason: "Couldn't find this zip's directory \u2014 it may be corrupt or unusually packaged, so it's blocked to be safe." };
  }

  const totalEntries = tail.readUInt16LE(eocdPos + 10);
  const cdSize = tail.readUInt32LE(eocdPos + 12);
  const cdOffset = tail.readUInt32LE(eocdPos + 16);

  const zip64LocatorPos = eocdPos - 20;
  const hasZip64Locator = zip64LocatorPos >= 0 && tail.readUInt32LE(zip64LocatorPos) === ZIP64_LOCATOR_SIG;
  if(totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || hasZip64Locator){
    return { safe:false, reason: 'This zip uses Zip64 (very large / many-entry) formatting, which can\u2019t be safely verified yet. Please re-package it as a standard zip.' };
  }
  if(cdOffset + cdSize > size){
    return { safe:false, reason: "This zip's directory claims a location outside the file itself, which isn't valid. Blocked." };
  }

  const cd = await readRange(handle, cdOffset, cdSize);

  let pos = 0;
  let entriesRead = 0;
  let totalUncompressed = 0;

  while(pos + 46 <= cd.length && entriesRead < totalEntries){
    if(cd.readUInt32LE(pos) !== ZIP_CD_SIG){
      return { safe:false, reason: "This zip's directory doesn't parse as expected. Blocked to be safe." };
    }
    const uncompressedSize = cd.readUInt32LE(pos + 24);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const compressedSize = cd.readUInt32LE(pos + 20);

    if(compressedSize === 0xffffffff || uncompressedSize === 0xffffffff){
      return { safe:false, reason: 'An entry inside this zip uses Zip64 sizing, which can\u2019t be verified here. Blocked.' };
    }
    if(uncompressedSize > LIMITS.MAX_SINGLE_ENTRY_UNCOMPRESSED){
      return { safe:false, reason: 'One file inside this archive claims to be larger than 5\u00a0GB uncompressed. Blocked as a likely archive bomb.' };
    }

    totalUncompressed += uncompressedSize;
    if(totalUncompressed > LIMITS.MAX_TOTAL_UNCOMPRESSED){
      return { safe:false, reason: 'This archive claims to unpack to more than 10\u00a0GB total. Blocked as a likely archive bomb.' };
    }

    pos += 46 + nameLen + extraLen + commentLen;
    entriesRead++;
  }

  if(entriesRead !== totalEntries){
    return { safe:false, reason: "This zip's entry count didn't match its directory. Blocked to be safe." };
  }

  const ratio = size > 0 ? totalUncompressed / size : 0;
  if(ratio > LIMITS.MAX_RATIO){
    return {
      safe:false,
      reason: `This zip expands to about ${ratio.toFixed(0)}\u00d7 its own size (${formatBytes(totalUncompressed)} from ${formatBytes(size)}). That's a classic archive-bomb signature, so it's blocked.`
    };
  }

  return { safe:true, info:{ entries: entriesRead, totalUncompressed, ratio } };
}

async function inspectGzip(handle, size){
  if(size < 18){
    return { safe:true, info:{ note: 'Too small to meaningfully check; allowed.' } };
  }
  const tail = await readRange(handle, size - 4, 4);
  const isize = tail.readUInt32LE(0); // wraps at 4GB, see caveat in comments below

  const ratio = isize / size;
  if(ratio > LIMITS.MAX_RATIO){
    return {
      safe:false,
      reason: `This gzip file expands to about ${ratio.toFixed(0)}\u00d7 its own size (${formatBytes(isize)} from ${formatBytes(size)}). Blocked as a likely archive bomb.`
    };
  }
  if(isize > LIMITS.MAX_SINGLE_ENTRY_UNCOMPRESSED){
    return { safe:false, reason: 'This gzip file claims to unpack to more than 5\u00a0GB. Blocked as a likely archive bomb.' };
  }
  // Caveat: ISIZE wraps at 4GB. A stream whose true size is an exact
  // multiple of 4GB could under-report. The overall 2GB on-disk cap
  // makes this a narrow edge case, but it's a real limitation of
  // trusting ISIZE alone rather than actually decompressing (which we
  // deliberately never do).
  return { safe:true, info:{ declaredUncompressed: isize, ratio } };
}

/**
 * Run only after the file is already fully (and cap-enforced) on disk.
 * Returns { safe, reason? , info? }.
 */
async function checkArchiveSafety(filePath){
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;
  const fd = await fs.promises.open(filePath, 'r');
  try{
    if(await looksLikeZip(fd, size)) return await inspectZip(fd, size);
    if(await looksLikeGzip(fd, size)) return await inspectGzip(fd, size);
    return { safe:true, info:null };
  }catch(e){
    if(process.env.NEXCORE_DEBUG) console.error(e);
    return { safe:false, reason: 'Could not safely read this file\u2019s structure, so it was blocked as a precaution.' };
  }finally{
    await fd.close();
  }
}

module.exports = { LIMITS, enforceUploadCap, checkArchiveSafety, formatBytes };
