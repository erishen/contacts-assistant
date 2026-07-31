#!/usr/bin/env node
/**
 * 从微信好友 CSV 生成 src/data/wechatContacts.local.ts（本地私有，含真实 PII）
 *
 * 用法：node scripts/buildWechatData.js <wechat-contacts.csv>
 * CSV 格式（带表头）：序号,姓名/备注名,微信ID,ID类型
 *
 * ⚠️ 生成的 wechatContacts.local.ts 已被 .gitignore 排除，禁止提交 / 开源。
 *    仓库内置的 wechatContacts.ts 是脱敏占位；克隆后无本地数据时由 metro.config.js 兜底。
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) {
  console.error('用法: node scripts/buildWechatData.js <wechat-contacts.csv>');
  process.exit(1);
}

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); field = ''; if (row.some((f) => f !== '')) rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

const rows = parseCsv(fs.readFileSync(src, 'utf8'));
rows.shift(); // header
const list = rows
  .filter((r) => r[1] && r[2])
  .map((r) => ({ n: r[1], w: r[2] }));

const out = `// 微信好友列表（备注名 -> 微信ID），由 scripts/buildWechatData.js 生成，请勿手改
// 数据来源：本地导出的 CSV（${path.basename(src)}），共 ${list.length} 条
// ⚠️ 含真实 PII（备注名 + 微信ID）。本文件已被 .gitignore 排除，禁止提交 / 开源。
export type WechatEntry = { n: string; w: string };
export const WECHAT_CONTACTS: WechatEntry[] = ${JSON.stringify(list)};
`;

const target = path.join(__dirname, '..', 'src', 'data', 'wechatContacts.local.ts');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log('wrote', target, 'entries:', list.length, 'bytes:', out.length);
