// 在线生成的跟进草稿：按联系人 wxid 存到本机 AsyncStorage。
// 可编辑、可覆盖重生成、跨会话保留。
// 仅落盘「生成结果 + 目标 + 场景」，不含任何手机号 / PII（PII 只存在于发给模型的提示词，不存本地）。
import AsyncStorage from '@react-native-async-storage/async-storage';

export type GeneratedDraft = {
  wxid: string;
  goal: string;
  scenarios: string[];
  result: Record<string, string>;
  raw: string;
  savedAt: string; // ISO 时间戳
};

const keyOf = (wxid: string) => `followup.gen.${wxid}`;

export async function loadGeneratedDraft(wxid: string): Promise<GeneratedDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(wxid));
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? (d as GeneratedDraft) : null;
  } catch {
    return null;
  }
}

export async function saveGeneratedDraft(d: GeneratedDraft): Promise<void> {
  await AsyncStorage.setItem(keyOf(d.wxid), JSON.stringify(d));
}

/** 清除全部已生成的跟进草稿（按 wxid 分散存储，遍历移除） */
export async function clearGeneratedDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter((k) => k.startsWith('followup.gen.'));
    if (targets.length) await AsyncStorage.multiRemove(targets);
  } catch {
    /* 忽略存储失败 */
  }
}
