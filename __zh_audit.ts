// TEMP audit script (not part of the product): quantify zh-CN translation coverage.
import { dict as en } from './packages/ui/src/lib/i18n/messages/en';
import { dict as zh } from './packages/ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTw } from './packages/ui/src/lib/i18n/messages/zh-TW';
import { settingsDict as enSettings } from './packages/ui/src/lib/i18n/messages/en.settings';
import { settingsDict as zhSettings } from './packages/ui/src/lib/i18n/messages/zh-CN.settings';

import { mkdirSync, writeFileSync } from 'node:fs';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

type Row = { key: string; en: string; zh: string; kind: 'identical' | 'no-cjk' | 'ok' };

function classify(enDict: Record<string, string>, zhDict: Record<string, string>, label: string) {
  const rows: Row[] = [];
  const enKeys = Object.keys(enDict);
  const missing: string[] = [];
  for (const key of enKeys) {
    const e = enDict[key];
    const z = zhDict[key];
    if (typeof z !== 'string') { missing.push(key); continue; }
    if (z === e) rows.push({ key, en: e, zh: z, kind: 'identical' });
    else if (!CJK.test(z)) rows.push({ key, en: e, zh: z, kind: 'no-cjk' });
    else rows.push({ key, en: e, zh: z, kind: 'ok' });
  }
  const identical = rows.filter((r) => r.kind === 'identical');
  const noCjk = rows.filter((r) => r.kind === 'no-cjk');
  console.log(`\n===== ${label} =====`);
  console.log(`keys(en)=${enKeys.length} keys(zh)=${Object.keys(zhDict).length} missing_in_zh=${missing.length}`);
  console.log(`identical_to_en=${identical.length}  no_cjk=${noCjk.length}  translated=${rows.length - identical.length - noCjk.length}`);

  const ns = (k: string) => k.split('.').slice(0, 2).join('.');
  const byNs = new Map<string, number>();
  for (const r of identical) byNs.set(ns(r.key), (byNs.get(ns(r.key)) ?? 0) + 1);
  const top = [...byNs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`--- top namespaces by identical_to_en ---`);
  for (const [name, count] of top) console.log(`${String(count).padStart(5)}  ${name}`);

  console.log(`--- 60 sample identical_to_en (en => zh) ---`);
  for (const r of identical.slice(0, 60)) {
    console.log(`${r.key}\n    EN: ${r.en.slice(0, 140)}\n    ZH: ${r.zh.slice(0, 140)}`);
  }
  console.log(`--- 40 sample no_cjk (en => zh) ---`);
  for (const r of noCjk.slice(0, 40)) {
    console.log(`${r.key}\n    EN: ${r.en.slice(0, 120)}\n    ZH: ${r.zh.slice(0, 120)}`);
  }
  return { rows, missing, identical, noCjk };
}

const main = classify(en as Record<string, string>, zh as Record<string, string>, 'main dict (en.ts vs zh-CN.ts)');
const settings = classify(enSettings as Record<string, string>, zhSettings as Record<string, string>, 'settings dict (en.settings.ts vs zh-CN.settings.ts)');

// zh-TW comparison: how much better/worse is traditional chinese coverage?
const zhTwRows = Object.keys(en as Record<string, string>).filter((k) => (zhTw as Record<string, string>)[k] === (en as Record<string, string>)[k]);
console.log(`\n(reference) zh-TW identical_to_en=${zhTwRows.length}`);

mkdirSync('T:/pigeoncore/i18n', { recursive: true });
const out = {
  generatedFor: 'openchamber-pigeon zh-CN coverage audit',
  main: {
    identical: main.identical.map((r) => ({ key: r.key, en: r.en, zh: r.zh })),
    noCjk: main.noCjk.map((r) => ({ key: r.key, en: r.en, zh: r.zh })),
    missing: main.missing,
  },
  settings: {
    identical: settings.identical.map((r) => ({ key: r.key, en: r.en, zh: r.zh })),
    noCjk: settings.noCjk.map((r) => ({ key: r.key, en: r.en, zh: r.zh })),
    missing: settings.missing,
  },
};
writeFileSync('T:/pigeoncore/i18n/zh-coverage.json', JSON.stringify(out, null, 2), 'utf8');
console.log('\nwrote T:/pigeoncore/i18n/zh-coverage.json');
