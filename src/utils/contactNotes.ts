// 本地联系人备注：仅存本机 AsyncStorage，不读取也不发送任何微信聊天记录 / 手机号 PII。
// 用户主动填写的备注会��生成「AI 起草 / AI 画像」时作为上下文传入模型，让输出更贴切。
import AsyncStorage from '@react-native-async-storage/async-storage';

const keyOf = (id: string) => `note.${id}`;

export async function loadNote(id: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(id));
    return raw || null;
  } catch {
    return null;
  }
}

/** 保存备注；传入空字符串则删除该备注 */
export async function saveNote(id: string, text: string): Promise<void> {
  const t = (text || '').trim();
  if (!t) {
    await AsyncStorage.removeItem(keyOf(id));
    return;
  }
  await AsyncStorage.setItem(keyOf(id), t);
}

/** 清除全部本地备注 */
export async function clearNotes(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter((k) => k.startsWith('note.'));
    if (targets.length) await AsyncStorage.multiRemove(targets);
  } catch {
    /* 忽略存储失败 */
  }
}

/** 批量读取全部备注，返回 { 联系人id: 备注文本 }（仅供本机智能查找构建上下文） */
export async function loadAllNotes(): Promise<Record<string, string>> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter((k) => k.startsWith('note.'));
    if (!targets.length) return {};
    const pairs = await AsyncStorage.multiGet(targets);
    const out: Record<string, string> = {};
    for (const [k, v] of pairs) {
      if (v && v.trim()) out[k.slice('note.'.length)] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}
