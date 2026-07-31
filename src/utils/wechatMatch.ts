/**
 * 微信好友匹配：把通讯录联系人姓名与内置微信好友列表做名字匹配。
 *
 * 匹配策略（与本地数据生成脚本保持一致）：
 * 1. 归一化精确匹配：去空格/标点/emoji、转小写后完全一致 —— 可靠；
 * 2. 包含匹配：一方名字包含另一方（长度 >= 2），仅唯一命中才算 —— 结果标记 fuzzy。
 */
import { WECHAT_CONTACTS as BASE_CONTACTS, WechatEntry } from '../data/wechatContacts';
import { WECHAT_FEATURES_ENABLED } from './wechatFeatureFlags';

// 本地真实微信数据（含真实 PII）：由 scripts/buildWechatData.js 生成到
// src/data/wechatContacts.local.ts，已被 .gitignore 排除，禁止提交 / 开源。
// 仓库克隆后无此文件，metro.config.js 会将其兜底解析到上方脱敏占位，保证可独立构建。
let WECHAT_CONTACTS: WechatEntry[] = BASE_CONTACTS;
// @ts-ignore 该模块在仓库中不存在（本地生成），由 Metro 兜底解析到脱敏占位
try {
  const local = require('../data/wechatContacts.local') as { WECHAT_CONTACTS?: WechatEntry[] };
  const localData = local?.WECHAT_CONTACTS;
  if (Array.isArray(localData) && localData.length > 0) {
    WECHAT_CONTACTS = localData;
  }
} catch {
  /* 预期：克隆仓库无本地真实数据，使用脱敏占位 */
}

export type WechatMatch = {
  /** 微信备注名 */
  name: string;
  /** 微信ID（wxid_ 开头为原始 ID，否则为自定义微信号） */
  wxid: string;
  /** true = 包含匹配（模糊），false = 精确匹配 */
  fuzzy: boolean;
};

/** 名字归一化：去空格/全角空格/常见标点/emoji，转小写 */
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(
      /[-_·•.。,，()（）[\]【】<>《》'"“”‘’!！?？~～@#%&*+=|\\/:;：；]/g,
      '',
    )
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
}

/** 归一化名 -> 微信条目（精确索引），懒初始化 */
let exactIndex: Map<string, WechatEntry> | null = null;
/** 归一化名列表（包含匹配用） */
let normKeys: { key: string; entry: WechatEntry }[] = [];

function ensureIndex(): void {
  if (exactIndex) return;
  exactIndex = new Map();
  normKeys = [];
  for (const e of WECHAT_CONTACTS) {
    const k = norm(e.n);
    if (!k) continue;
    // 同名冲突时保留先出现的（后续同名走包含匹配也命不中，安全）
    if (!exactIndex.has(k)) exactIndex.set(k, e);
    normKeys.push({ key: k, entry: e });
  }
}

/** 结果缓存：联系人姓名 -> 匹配结果（null = 无匹配） */
const cache = new Map<string, WechatMatch | null>();

/**
 * 查找联系人姓名对应的微信好友。
 * @returns 匹配结果；无匹配返回 null
 */
export function findWechat(contactName: string): WechatMatch | null {
  // 对外发布包（WECHAT_FEATURES_ENABLED=false）不含任何微信数据，直接返回未匹配，
  // 与 ContactsScreen 的 UI 收起互为双保险。
  if (!WECHAT_FEATURES_ENABLED) return null;
  if (!contactName) return null;
  const hit = cache.get(contactName);
  if (hit !== undefined) return hit;

  ensureIndex();
  const n = norm(contactName);
  let result: WechatMatch | null = null;

  if (n) {
    const exact = exactIndex!.get(n);
    if (exact) {
      result = { name: exact.n, wxid: exact.w, fuzzy: false };
    } else if (n.length >= 2) {
      // 包含匹配：仅唯一命中才算
      let only: WechatEntry | null = null;
      let count = 0;
      for (const { key, entry } of normKeys) {
        if (key.length >= 2 && (key.includes(n) || n.includes(key))) {
          count++;
          if (count > 1) break;
          only = entry;
        }
      }
      if (count === 1 && only) {
        result = { name: only.n, wxid: only.w, fuzzy: true };
      }
    }
  }

  cache.set(contactName, result);
  return result;
}
