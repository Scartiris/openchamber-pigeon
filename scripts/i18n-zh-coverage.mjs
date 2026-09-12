#!/usr/bin/env node
/**
 * pigeon fork 汉化覆盖率校验。
 *
 * 判定规则：
 *   1. zh-CN 字典必须覆盖 en 字典的全部键（缺一个就报错）；
 *   2. zh-CN 的值不得存在 `{{placeholder}}` 占位符丢失；
 *   3. 除 scripts/i18n-zh-allowlist.json 里人工确认过的「刻意保留英文」条目外，
 *      任何键的中文值都不得与英文完全相同（即不允许漏译）。
 *
 * 用法（服务器上无需安装依赖，直接在 bun 容器里跑）：
 *   docker run --rm -v /opt/openchamber-pigeon-zh:/app -w /app oven/bun:1.3.14 \
 *     bun scripts/i18n-zh-coverage.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const en = (await import(`${repoRoot}/packages/ui/src/lib/i18n/messages/en.ts`)).dict;
const zh = (await import(`${repoRoot}/packages/ui/src/lib/i18n/messages/zh-CN.ts`)).dict;
const allowlistRaw = JSON.parse(readFileSync(join(here, 'i18n-zh-allowlist.json'), 'utf8'));
const allowlist = new Set(allowlistRaw.entries.map((entry) => entry.key));

const enKeys = Object.keys(en);
const zhKeys = new Set(Object.keys(zh));

const missing = enKeys.filter((key) => !zhKeys.has(key));
const placeholderLost = [];
const placeholderExtra = [];
const untranslated = [];

const placeholdersOf = (value) => new Set(String(value).match(/\{(\w+)\}/g) ?? []);

for (const key of enKeys) {
  const enValue = en[key];
  const zhValue = zh[key];
  if (typeof zhValue !== 'string') continue;

  const enPlaceholders = placeholdersOf(enValue);
  const zhPlaceholders = placeholdersOf(zhValue);
  // 少传占位符 = 丢信息（真错误）；多传占位符 = 中文比英文更完整（需人确认调用点确实传了该参数）
  const lost = [...enPlaceholders].filter((token) => !zhPlaceholders.has(token));
  const extra = [...zhPlaceholders].filter((token) => !enPlaceholders.has(token));
  if (lost.length) placeholderLost.push({ key, en: enValue, zh: zhValue, lost });
  if (extra.length) placeholderExtra.push({ key, en: enValue, zh: zhValue, extra });

  if (zhValue === enValue && !allowlist.has(key)) {
    untranslated.push({ key, value: enValue });
  }
}

const translated = enKeys.length - untranslated.length - allowlist.size;
const coverage = ((translated / (enKeys.length - allowlist.size)) * 100).toFixed(2);

console.log('=== pigeon fork 汉化覆盖率报告 ===');
console.log(`英文键总数            : ${enKeys.length}`);
console.log(`中文键总数            : ${zhKeys.size}`);
console.log(`缺失键                : ${missing.length}`);
console.log(`刻意保留英文（白名单）: ${allowlist.size}`);
console.log(`丢失占位符（错误）    : ${placeholderLost.length}`);
console.log(`多余占位符（告警）    : ${placeholderExtra.length}`);
console.log(`仍与英文相同（漏译）  : ${untranslated.length}`);
console.log(`中文化覆盖率          : ${coverage}%`);

if (missing.length) {
  console.log('\n--- 缺失键 ---');
  for (const key of missing.slice(0, 40)) console.log(`  ${key}`);
}
if (placeholderLost.length) {
  console.log('\n--- 丢失占位符（中文缺少英文里的参数）---');
  for (const row of placeholderLost.slice(0, 40)) console.log(`  ${row.key}\n    EN: ${row.en}\n    ZH: ${row.zh}\n    丢失: ${row.lost.join(', ')}`);
}
if (placeholderExtra.length) {
  console.log('\n--- 多余占位符（中文用到英文没有的参数，需确认调用点确实传入）---');
  for (const row of placeholderExtra.slice(0, 40)) console.log(`  ${row.key}  额外: ${row.extra.join(', ')}`);
}
if (untranslated.length) {
  console.log('\n--- 漏译（不在白名单内却仍为英文）---');
  for (const row of untranslated.slice(0, 60)) console.log(`  ${row.key} = ${row.value}`);
}

const failed = missing.length + placeholderLost.length + untranslated.length > 0;
console.log(failed ? '\n结果：未通过' : '\n结果：通过（中文覆盖率 100%，术语按白名单保留英文）');
process.exit(failed ? 1 : 0);
