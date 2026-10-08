// Usage examples:
//   node tools/normalize-characters.js my-database.json
//   node tools/normalize-characters.js my-database.json data/characters.json
// Accepts either: ["Luffy", "Zoro"] or {"characters":[{"name":{"en":"MONKEY D. LUFFY"}}]}
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
const dest = process.argv[3] || path.join(__dirname, '..', 'data', 'characters.json');
if (!src) throw new Error('Pass the source JSON file path.');
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
let items = Array.isArray(raw) ? raw : raw.characters || raw.data || [];
const names = [];
for (const item of items) {
  const value = typeof item === 'string' ? item : item?.name?.en || item?.name?.english || item?.name || item?.character || item?.Name;
  if (typeof value === 'string') names.push(value.trim());
}
const unique = [...new Set(names.filter(Boolean))].sort((a,b)=>a.localeCompare(b));
if (unique.length < 48) throw new Error(`Only found ${unique.length} usable names; need at least 48.`);
fs.writeFileSync(dest, JSON.stringify(unique, null, 2) + '\n');
console.log(`Wrote ${unique.length} unique character names to ${dest}`);
