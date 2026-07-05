const fs = require('fs');
const path = require('path');
const { createHash, createPrivateKey, sign } = require('crypto');

const root = __dirname;
const keyPath = process.env.DUPA_SIGNING_KEY || 'D:/@PROJECT/OpenSphere/dupa-signing-key.pem';
const entryPath = path.join(root, 'ui-shell', 'ui-shell.plugin.js');
const manifestPath = path.join(root, 'ui-shell', 'ui-shell.manifest.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const entrySha256 = sha256(fs.readFileSync(entryPath));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.entrySha256 = entrySha256;

const manifestText = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(manifestPath, manifestText);

const manifestSha256 = sha256(Buffer.from(manifestText));
const key = createPrivateKey(fs.readFileSync(keyPath));
const signature = sign('sha256', Buffer.from(manifestText), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
fs.writeFileSync(`${manifestPath}.sig`, `${signature}\n`);

console.log(JSON.stringify({ entrySha256, manifestSha256 }, null, 2));
