// 「关于我」——用户自己的身份设定，供 AI 画像 / AI 起草作为「我方信息」上下文。
//
// 设计边界（隐私 / 可分发）：
// - 这是用户主动填写的「自己」的资料（性别、希望被称呼），不是任何第三方的隐私；
// - 仅存本机 AsyncStorage，只发往用户自己配置的 LLM，不进代码仓库、不随包发布；
// - 默认 gender='unspecified'（不假定），画像/起草在性别未指定时给中性建议、不脑补。
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Gender = 'male' | 'female' | 'unspecified';

export type UserProfile = {
  gender: Gender;
  selfName?: string; // 希望对方怎么称呼我（可选，如「老王」「阿强」）
};

const KEY = 'user.profile';

export const DEFAULT_PROFILE: UserProfile = {
  gender: 'unspecified',
  selfName: '',
};

export async function loadProfile(): Promise<UserProfile> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return { ...DEFAULT_PROFILE };
    return {
      gender: d.gender === 'male' || d.gender === 'female' ? d.gender : 'unspecified',
      selfName: typeof d.selfName === 'string' ? d.selfName : '',
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export async function saveProfile(p: UserProfile): Promise<void> {
  const clean: UserProfile = {
    gender: p.gender === 'male' || p.gender === 'female' ? p.gender : 'unspecified',
    selfName: (p.selfName || '').trim(),
  };
  await AsyncStorage.setItem(KEY, JSON.stringify(clean));
}
