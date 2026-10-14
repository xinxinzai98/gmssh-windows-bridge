/* Extract the unchanged, pinned official portable payload. Node supplies Brotli. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node unpack_rustdesk.cjs official.exe new-output-directory');
const metadata = require('../gmssh_windows_bridge/windows-installers.json').rustdesk;
const data = fs.readFileSync(input);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (digest(data) !== metadata.sha256) throw new Error('official RustDesk digest mismatch');
if (fs.existsSync(output)) throw new Error('output already exists');
const magic = Buffer.from('rustdesk');
const candidates = [];
for (let at = data.indexOf(magic); at >= 0; at = data.indexOf(magic, at + 1)) {
  if (at + 12 > data.length) continue;
  const size = data.readUInt32BE(at + 8);
  if (size > 0 && size < 512 && /^[.]\\/.test(data.subarray(at + 12, at + 12 + size).toString('utf8'))) candidates.push(at);
}
if (candidates.length !== 1) throw new Error('unrecognized official portable payload');
let at = candidates[0] + magic.length, total = 0;
const files = {};
while (!data.subarray(at, at + magic.length).equals(magic)) {
  const nameSize = data.readUInt32BE(at); at += 4;
  if (!nameSize || nameSize > 512) throw new Error('invalid payload path');
  const name = data.subarray(at, at + nameSize).toString('utf8').replaceAll('\\', '/').replace(/^\.\//, ''); at += nameSize;
  if (name.includes(':') || name.startsWith('/') || name.split('/').some(x => !x || x === '..') || files[name]) throw new Error('unsafe payload path');
  const size = data.readUInt32BE(at); at += 4;
  if (at + size + 32 > data.length) throw new Error('truncated payload');
  const body = zlib.brotliDecompressSync(data.subarray(at, at + size), { maxOutputLength: 256 * 1024 * 1024 }); at += size;
  const md5 = data.subarray(at, at + 32).toString('ascii'); at += 32;
  if (crypto.createHash('md5').update(body).digest('hex') !== md5) throw new Error('payload content mismatch');
  total += body.length;
  if (total > 512 * 1024 * 1024 || Object.keys(files).length > 5000) throw new Error('payload limit exceeded');
  const destination = path.join(output, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body, { flag: 'wx' });
  files[name] = digest(body);
}
if (!files['rustdesk.exe']) throw new Error('native desktop engine missing');
fs.writeFileSync(path.join(output, 'engine-files.json'), JSON.stringify({ source: metadata, files }, null, 2));
process.stdout.write(JSON.stringify({ files: Object.keys(files).length, bytes: total, output }) + '\n');
