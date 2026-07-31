/**
 * 通讯录 CSV 导出（本地生成 + 系统分享）
 *
 * - 使用 expo-file-system SDK 54+ 新 OO API（File/Paths），写入 cache 目录
 * - 使用 expo-sharing 调起系统分享面板（存到文件 App / AirDrop / 微信等）
 * - CSV 头部加 UTF-8 BOM，保证 Excel 打开中文不乱码
 * - 手机号列前加制表符前缀由调用方决定；这里保留原样字符串
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { WECHAT_FEATURES_ENABLED } from './wechatFeatureFlags';

export type CsvContact = {
  name: string;
  phone: string;
  province: string;
  city: string;
  operator: string;
  emails: string;
  /** 微信备注名（匹配到时才有） */
  wechatName?: string;
  /** 微信ID（匹配到时才有） */
  wechatId?: string;
};

/** CSV 字段转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍 */
function esc(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** 生成 CSV 文本（含 BOM 与表头） */
export function buildCsv(rows: CsvContact[]): string {
  const header = [
    '姓名',
    '手机号',
    '省份',
    '城市',
    '运营商',
    '邮箱',
    ...(WECHAT_FEATURES_ENABLED ? ['微信备注名', '微信ID'] : []),
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.phone,
        r.province,
        r.city,
        r.operator,
        r.emails,
        ...(WECHAT_FEATURES_ENABLED ? [r.wechatName ?? '', r.wechatId ?? ''] : []),
      ]
        .map(esc)
        .join(','),
    );
  }
  // \uFEFF = UTF-8 BOM，Excel 识别中文必需
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * 导出并分享 CSV。
 * @returns 生成的文件 URI；用户取消分享不算失败。
 */
export async function exportContactsCsv(rows: CsvContact[]): Promise<string> {
  const csv = buildCsv(rows);
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '')
    .replace('T', '-');
  const file = new File(Paths.cache, `contacts-${stamp}.csv`);
  file.write(csv);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/csv',
      dialogTitle: '导出通讯录 CSV',
      UTI: 'public.comma-separated-values-text',
    });
  }
  return file.uri;
}
