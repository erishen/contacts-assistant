// 脱敏占位：仓库克隆后无本地真实草稿，使用空表（真实数据在 followupDrafts.local.ts，被 gitignore 排除）。
// 由 metro.config.js 兜底解析到本占位，保证仓库可独立构建，不泄露任何私人语境。
export type FollowupDraft = {
  wxid: string;
  name: string;
  draft: string;
  goal: string;
  generatedAt: string;
  msgCount: number;
};

export const FOLLOWUP_DRAFTS: Record<string, FollowupDraft> = {};
