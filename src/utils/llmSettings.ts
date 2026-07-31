// LLM 设置存取：与 ai-workbench 桌面端同一密钥纪律 ——
// 公开配置（baseURL/model/provider）存 AsyncStorage；
// API Key 存 expo-secure-store（iOS Keychain / Android Keystore），绝不与公开配置同处。
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export type LlmConfig = {
  id: string;
  providerId: string; // 预设服务商 id，或 'custom'
  label: string; // 显示名（默认取 provider label）
  baseURL: string;
  model: string;
  hasKey: boolean; // 是否已存过 Key（不含 Key 本身）
};

const CONFIGS_KEY = 'llm.configs';
const ACTIVE_KEY = 'llm.activeId';
// SecureStore 的 key 只允许字母数字 . - _
const secureKeyOf = (id: string) => `llm.key.${id}`;

export function newConfigId(): string {
  return `cfg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function loadConfigs(): Promise<LlmConfig[]> {
  try {
    const raw = await AsyncStorage.getItem(CONFIGS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function loadActiveId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

async function persistConfigs(list: LlmConfig[]): Promise<void> {
  await AsyncStorage.setItem(CONFIGS_KEY, JSON.stringify(list));
}

export async function setActiveId(id: string): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_KEY, id);
  emitActiveConfigChange();
}

// 主配置变化通知：设置页切换/首次激活主模型时触发，
// 供 ChatScreen 中断在途 LLM 请求（避免用旧模型把回复写回、或切换时机卡巧用上新模型）。
type CfgListener = () => void;
const cfgListeners = new Set<CfgListener>();
export function onActiveConfigChange(fn: CfgListener): () => void {
  cfgListeners.add(fn);
  return () => {
    cfgListeners.delete(fn);
  };
}
function emitActiveConfigChange(): void {
  cfgListeners.forEach((l) => l());
}

/** 新增或更新一条配置；apiKey 传 undefined = 不改动已存 Key，传 '' = 清除 Key */
export async function upsertConfig(
  cfg: Omit<LlmConfig, 'hasKey'>,
  apiKey?: string,
): Promise<LlmConfig[]> {
  const list = await loadConfigs();
  const idx = list.findIndex((c) => c.id === cfg.id);
  let hasKey = idx >= 0 ? list[idx].hasKey : false;

  // 保存时自动去除 Key 首尾空白（手机粘贴容易带入空格/换行，否则会 401）
  const trimmedKey = apiKey === undefined ? undefined : apiKey.trim();
  if (trimmedKey !== undefined) {
    if (trimmedKey) {
      await SecureStore.setItemAsync(secureKeyOf(cfg.id), trimmedKey);
      hasKey = true;
    } else {
      await SecureStore.deleteItemAsync(secureKeyOf(cfg.id));
      hasKey = false;
    }
  }

  const full: LlmConfig = { ...cfg, hasKey };
  if (idx >= 0) list[idx] = full;
  else list.push(full);
  await persistConfigs(list);

  // 首条配置自动设为主配置
  const active = await loadActiveId();
  if (!active) await setActiveId(cfg.id);
  return list;
}

export async function deleteConfig(id: string): Promise<LlmConfig[]> {
  const list = (await loadConfigs()).filter((c) => c.id !== id);
  await persistConfigs(list);
  await SecureStore.deleteItemAsync(secureKeyOf(id));
  const active = await loadActiveId();
  if (active === id) {
    if (list.length > 0) await setActiveId(list[0].id);
    else await AsyncStorage.removeItem(ACTIVE_KEY);
  }
  return list;
}

export async function getApiKey(id: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(secureKeyOf(id));
  } catch {
    return null;
  }
}

/** 取主配置 + 其 Key（供后续 AI 功能调用） */
export async function getActiveConfig(): Promise<
  (LlmConfig & { apiKey: string | null }) | null
> {
  const [list, active] = await Promise.all([loadConfigs(), loadActiveId()]);
  const cfg = list.find((c) => c.id === active) ?? list[0];
  if (!cfg) return null;
  const apiKey = await getApiKey(cfg.id);
  return { ...cfg, apiKey };
}
