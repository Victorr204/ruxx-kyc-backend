// Audit: list every bare-module import under api/ and lib/ vs package.json deps.
import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies || {}));

const found = new Set();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^.'"\/][^'"]*)['"]/g)) {
        const mod = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
        found.add(`${mod} (${p})`);
      }
    }
  }
};
walk('api');
walk('lib');

const mods = [...found].map((f) => [f.slice(0, f.indexOf(' (')), f.slice(f.indexOf(' (') + 1)]);
const bare = [...new Set(mods.map(([m]) => m))];
for (const m of bare) {
  const files = mods.filter(([mm]) => mm === m).map(([, f]) => f);
  console.log(`${declared.has(m) ? 'OK  ' : 'MISS'} ${m} — ${files.join(', ')}`);
}
