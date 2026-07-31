// 把 followup_drafts.local.md 解析为移动端可直接 import 的结构化 TS 数据。
//
// 设计：
// - markdown 是「单一自然语言开场白」的源（由 scripts/generate_followup.py 产出）；
// - 移动端按 wxid（稳定唯一标识）建索引，联系人经 findWechat(name) 拿到 wxid 后查表；
// - 真实草稿落在 src/data/followupDrafts.local.ts（被 *.local.ts gitignore 排除，含私人语境）；
//   仓库克隆后该文件不存在，由 metro.config.js 兜底到脱敏占位 followupDrafts.ts。
//
// 用法： node scripts/build_followup_drafts.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = path.resolve(__dirname, '..', '..');
// 允许通过 DRAFTS_MD 覆盖源 markdown（与 Makefile 的 OUT 联动）；不传则用默认。
const mdPath = process.env.DRAFTS_MD
  ? path.resolve(process.env.DRAFTS_MD)
  : path.join(RESEARCH, 'scripts', 'followup_drafts.local.md');
const outPath = path.join(RESEARCH, 'contacts-assistant', 'src', 'data', 'followupDrafts.local.ts');

if (!fs.existsSync(mdPath)) {
  console.error(`缺少源文件：${mdPath}`);
  process.exit(1);
}

const text = fs.readFileSync(mdPath, 'utf8');
const lines = text.split('\n');

const entries = [];
let cur = null;
let draftLines = [];

const HEADER = /^##\s+(.+?)（(.+?)）\s*·\s*(\S+)\s*·\s*(.+)$/;
const COUNT = /消息量：\s*(\d+)\s*条/;

for (const raw of lines) {
  const h = raw.match(HEADER);
  if (h) {
    if (cur) {
      cur.draft = draftLines.join('\n').trim();
      entries.push(cur);
    }
    cur = {
      name: h[1].trim(),
      wxid: h[2].trim(),
      goal: h[3].trim(),
      generatedAt: h[4].trim(),
      msgCount: 0,
    };
    draftLines = [];
    continue;
  }
  if (!cur) continue;
  const c = raw.match(COUNT);
  if (c) {
    cur.msgCount = parseInt(c[1], 10) || 0;
    continue;
  }
  if (raw.trim() === '---' || raw.trim() === '') continue; // 分隔线 / 草稿内空行
  draftLines.push(raw.trim());
}
if (cur) {
  cur.draft = draftLines.join('\n').trim();
  entries.push(cur);
}

const header =
  '// AUTO-GENERATED from ../../scripts/followup_drafts.local.md — do not edit by hand.\n' +
  '// 本地私有草稿：基于历史聊天的预生成微信开场白，含私人语境，禁止提交 / 开源（见 .gitignore）。\n' +
  '// 重新生成： node scripts/build_followup_drafts.mjs\n\n';

const typeDef =
  'export type FollowupDraft = {\n' +
  '  wxid: string;\n' +
  '  name: string;\n' +
  '  draft: string;\n' +
  '  goal: string;\n' +
  '  generatedAt: string;\n' +
  '  msgCount: number;\n' +
  '};\n\n';

const mapEntries = entries
  .map((e) => {
    const val =
      '{\n' +
      `    wxid: ${JSON.stringify(e.wxid)},\n` +
      `    name: ${JSON.stringify(e.name)},\n` +
      `    draft: ${JSON.stringify(e.draft)},\n` +
      `    goal: ${JSON.stringify(e.goal)},\n` +
      `    generatedAt: ${JSON.stringify(e.generatedAt)},\n` +
      `    msgCount: ${e.msgCount},\n` +
      '  }';
    return `  ${JSON.stringify(e.wxid)}: ${val},`;
  })
  .join('\n');

const out =
  header +
  typeDef +
  `export const FOLLOWUP_DRAFTS: Record<string, FollowupDraft> = {\n${mapEntries}\n};\n`;

fs.writeFileSync(outPath, out, 'utf8');
console.log(`Wrote ${entries.length} drafts -> ${outPath}`);
