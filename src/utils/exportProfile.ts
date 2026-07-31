/**
 * 联系人档案导出（Markdown + 系统分享）
 *
 * - 在已有「CSV 导出」之外，提供一份「档案导出」：把每位联系人的
 *   本地备注 + AI 画像 + AI 草稿 一并整理成 Markdown，走系统分享面板
 *   （存到文件 App / AirDrop / 微信等）。
 * - 仅读取本机已生成的数据（备注 / 画像 / 草稿），不含任何微信聊天记录、不含手机号原文以外的隐私。
 * - 使用 expo-file-system SDK 54+ 新 OO API（File/Paths），写入 cache 目录。
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getPhoneMeta } from './phoneMeta';
import { loadNote } from './contactNotes';
import { loadComposedDraft } from './contactComposer';
import { loadInsight } from './contactInsight';

export type ProfileContact = {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
};

export type ProfileOptions = {
  includeNote?: boolean; // 本地备注，默认 true
  includeInsight?: boolean; // AI 画像，默认 true
  includeDraft?: boolean; // AI 草稿，默认 true
};

/** 手机号一行：号码 + 归属地/运营商（若有） */
function phoneLine(p: string): string {
  const meta = getPhoneMeta(p);
  const region =
    meta && (meta.province || meta.city)
      ? meta.province && meta.city && meta.province !== meta.city
        ? `${meta.province}·${meta.city}`
        : meta.province || meta.city
      : '';
  const tag = [region, meta?.operator].filter(Boolean).join(' ');
  return `- ${p}${tag ? `  _(${tag})_` : ''}`;
}

/** 生成完整 Markdown 档案文本（不含 BOM；.md 无需 BOM） */
export async function buildProfileMarkdown(
  contacts: ProfileContact[],
  opts: ProfileOptions = {},
): Promise<string> {
  const incNote = opts.includeNote ?? true;
  const incInsight = opts.includeInsight ?? true;
  const incDraft = opts.includeDraft ?? true;

  const blocks: string[] = [];
  blocks.push('# 联系人档案');
  blocks.push('');
  blocks.push(`> 由「联系人助手」导出 · 生成于 ${new Date().toLocaleString('zh-CN')}`);
  blocks.push('');

  for (const c of contacts) {
    const head: string[] = [`## ${c.name || '(无姓名)'}`];
    if (c.phones.length) {
      head.push('');
      head.push('**手机号**');
      head.push(...c.phones.map(phoneLine));
    }
    if (c.emails.length) {
      head.push('');
      head.push(`**邮箱**：${c.emails.join('；')}`);
    }
    blocks.push(head.join('\n'));

    if (incNote) {
      const note = (await loadNote(c.id))?.trim();
      if (note) {
        blocks.push('');
        blocks.push('### 📝 本地备注');
        blocks.push('');
        blocks.push(note);
      }
    }

    if (incInsight) {
      const ins = await loadInsight(c.id);
      if (ins && (ins.persona || ins.advice || ins.icebreaker)) {
        blocks.push('');
        blocks.push('### 💡 AI 画像');
        if (ins.persona) blocks.push(`- **关系定位**：${ins.persona}`);
        if (ins.advice) blocks.push(`- **沟通分寸**：${ins.advice}`);
        if (ins.icebreaker) blocks.push(`- **破冰示例**：${ins.icebreaker}`);
      }
    }

    if (incDraft) {
      const d = await loadComposedDraft(c.id);
      if (d && d.result && Object.keys(d.result).length) {
        blocks.push('');
        blocks.push('### ✍️ AI 起草');
        if (d.goal) blocks.push(`> 目标：${d.goal}`);
        if (d.relation) blocks.push(`> 关系/称呼：${d.relation}`);
        for (const [k, v] of Object.entries(d.result)) {
          blocks.push('');
          blocks.push(`**${k}**`);
          blocks.push('');
          blocks.push(v);
        }
      }
    }

    blocks.push('');
    blocks.push('---');
    blocks.push('');
  }

  return blocks.join('\n');
}

/**
 * 导出并分享联系人档案（Markdown）。
 * @returns 生成的文件 URI；用户取消分享不算失败。
 */
export async function exportContactsProfile(
  contacts: ProfileContact[],
  opts?: ProfileOptions,
): Promise<string> {
  const md = await buildProfileMarkdown(contacts, opts);
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '')
    .replace('T', '-');
  const file = new File(Paths.cache, `contacts-profile-${stamp}.md`);
  file.write(md);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/markdown',
      dialogTitle: '导出联系人档案',
      UTI: 'public.markdown',
    });
  }
  return file.uri;
}
