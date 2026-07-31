// 预生成跟进草稿查询：把联系人查到的 wxid 映射到离线草稿。
//
// 与 wechatMatch.ts 同样的「本地真实数据优先、占位兜底」模式：
// - 仓库内只有脱敏占位 followupDrafts.ts（空表）；
// - 本地真实草稿由 scripts/build_followup_drafts.mjs 从 followup_drafts.local.md 生成到
//   followupDrafts.local.ts（.gitignore 排除，含私人语境），运行时优先加载。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FOLLOWUP_DRAFTS as BASE, FollowupDraft } from '../data/followupDrafts';
import { WECHAT_FEATURES_ENABLED } from './wechatFeatureFlags';

let FOLLOWUP_DRAFTS: Record<string, FollowupDraft> = BASE;
// @ts-ignore 本地模块在仓库中不存在（本地生成），由 Metro 兜底到脱敏占位
try {
  const local = require('../data/followupDrafts.local') as {
    FOLLOWUP_DRAFTS?: Record<string, FollowupDraft>;
  };
  if (local?.FOLLOWUP_DRAFTS) FOLLOWUP_DRAFTS = local.FOLLOWUP_DRAFTS;
} catch {
  /* 预期：克隆仓库无本地草稿，使用空占位 */
}

// ===== 两层开关 =====
// ① 编译期总开关（.env 控制）：由 EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED 决定。
//    true / 未设置 = 启用；false = 彻底关闭该模块。
//    该常量在打包时由 Expo 将 EXPO_PUBLIC_ 前缀变量内联进 process.env，
//    因此「改 .env 必须重新构建（make deploy-release）才生效」，运行时无法绕过。
// ② 运行期用户开关（设置页控制）：仅在①开启时才有意义。
//    ① 的判定与 wechatMatch 共用同一环境变量（见 wechatFeatureFlags.ts）。
const FEATURE_ENABLED = WECHAT_FEATURES_ENABLED;

const ENABLED_KEY = 'privacy.wechatDraftsEnabled';
let enabled = true;

/** App 启动时调用一次，把持久化的运行期开关载入内存（编译开关关闭时强制为关） */
export async function loadWechatDraftsEnabled(): Promise<void> {
  if (!FEATURE_ENABLED) {
    enabled = false;
    return;
  }
  try {
    const v = await AsyncStorage.getItem(ENABLED_KEY);
    enabled = v === null ? true : v === '1';
  } catch {
    enabled = true;
  }
}

/** 编译期总开关（.env 控制）：供设置页决定是否展示该功能及运行期开关 */
export function isWechatDraftsFeatureEnabled(): boolean {
  return FEATURE_ENABLED;
}

/** 当前是否启用（编译开关 + 运行期开关，内存态，供同步查询使用） */
export function isWechatDraftsEnabledSync(): boolean {
  return FEATURE_ENABLED && enabled;
}

/** 持久化并切换运行期开关（编译开关关闭时调用无效） */
export async function setWechatDraftsEnabled(on: boolean): Promise<void> {
  if (!FEATURE_ENABLED) return;
  enabled = on;
  try {
    await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* 忽略存储失败 */
  }
}

/** 按 wxid 查找预生成草稿；编译/运行期任一开关关闭或 wxid 为空均返回 null */
export function findFollowupDraft(wxid: string): FollowupDraft | null {
  if (!FEATURE_ENABLED || !enabled || !wxid) return null;
  return FOLLOWUP_DRAFTS[wxid] ?? null;
}

export { FOLLOWUP_DRAFTS };
export type { FollowupDraft };
