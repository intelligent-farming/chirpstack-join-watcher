#!/usr/bin/env node
// Download IEEE OUI registries (MA-L, MA-M, MA-S) and bake data/ouis.json.
// Run once to seed the bundled snapshot; consumers should use updateOuis() at runtime.

const fs = require('fs');
const https = require('https');
const path = require('path');
const { parseOuiCsv } = require('../dist');

const URLS = [
  'https://standards-oui.ieee.org/oui/oui.csv',
  'https://standards-oui.ieee.org/oui28/mam.csv',
  'https://standards-oui.ieee.org/oui36/oui36.csv',
];
const OUT = path.join(__dirname, '..', 'data', 'ouis.json');

const fetchText = url => new Promise((resolve, reject) => {
  https.get(url, res => {
    if (res.statusCode !== 200) return reject(new Error(`${url} → HTTP ${res.statusCode}`));
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  }).on('error', reject);
});

(async () => {
  const merged = {};
  for (const url of URLS) Object.assign(merged, parseOuiCsv(await fetchText(url)));
  fs.writeFileSync(OUT, JSON.stringify(merged));
  const counts = { 6: 0, 7: 0, 9: 0 };
  for (const k of Object.keys(merged)) counts[k.length]++;
  console.log(`wrote ${Object.keys(merged).length} entries: MA-L=${counts[6]}, MA-M=${counts[7]}, MA-S=${counts[9]}`);
})();
