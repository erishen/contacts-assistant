// 通用「AI 联系人画像 / 怎么打交道」：与微信完全解耦，public / self 构建都可使用。
//
// 设计边界（隐私 / 可分发）：
// - 只用到联系人「姓名」+「手机号归属地」（内置号段表 phoneMeta，非隐私 PII）
//   + 用户自定义的「关系 / 称呼偏好」，不读取也不发送任何微信聊天记录；
// - 不臆测对方具体身份 / 职业 / 往事，只基于有限信息给通用得体的沟通建议；
// - 生成的画像按联系人 id 落盘本机 AsyncStorage，可覆盖 / 跨会话保留，但不存 PII。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { chatOnce } from './llmClient';
import type { UserProfile } from './userProfile';

const genderLabel = (g?: UserProfile['gender']): string => {
  if (g === 'male') return '男';
  if (g === 'female') return '女';
  return '未指定（请勿假定，给出中性、不依赖性别的建议）';
};

export type ContactInsight = {
  id: string; // 联系人 id
  name: string;
  raw: string;
  persona: string; // 关系定位
  advice: string; // 沟通分寸 / 建议
  icebreaker: string; // 破冰示例
  savedAt: string; // ISO 时间戳
  relation?: string; // 用户填写的关系 / 称呼偏好（可选）
};

const keyOf = (id: string) => `insight.gen.${id}`;

export async function loadInsight(id: string): Promise<ContactInsight | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(id));
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? (d as ContactInsight) : null;
  } catch {
    return null;
  }
}

export async function saveInsight(d: ContactInsight): Promise<void> {
  await AsyncStorage.setItem(keyOf(d.id), JSON.stringify(d));
}

/** 清除全部已生成的画像 */
export async function clearInsights(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter((k) => k.startsWith('insight.gen.'));
    if (targets.length) await AsyncStorage.multiRemove(targets);
  } catch {
    /* 忽略存储失败 */
  }
}

/** 组装发给模型的提示词（不含任何私人聊天记录 / 手机号） */
export function buildInsightPrompt(input: {
  name: string;
  location: string;
  relation?: string;
  note?: string;
  me?: UserProfile;
}): string {
  const { name, location, relation, note, me } = input;
  const meBlock = me
    ? `性别：${genderLabel(me.gender)}\n${
        me.selfName && me.selfName.trim() ? `希望被称呼为：${me.selfName.trim()}\n` : ''
      }`
    : `性别：未指定（请勿假定，给出中性、不依赖性别的建议）\n`;
  return `请基于下面信息，给出「我（发起方）怎么和这个人打交道」的简短建议（口语化、像朋友间的经验分享，每条不超过 60 字，不要编造对方具体身份或经历）。

【联系人信息】
姓名/备注：${name}
手机号归属地：${location || '未知'}
${relation ? `关系 / 称呼偏好：${relation}\n` : ''}
${(note && note.trim()) ? `本地备注：${note.trim()}\n` : ''}
【我方信息】
${meBlock}
【要求】
- 只基于上述信息给通用、得体的建议，不要臆测对方职业、身份或往事
- 用名字称呼对方（姓可舍去，如对方叫张伟则称呼"伟"）；若不确定辈分用名字或中性称呼，勿默认使用"哥""姐"等隐含对方年长含义的称呼；若我方提供了「希望被称呼为」，涉及我的自称时优先使用该称呼
- 「沟通分寸」必须结合我方性别与对方可能的关系来给建议（例如异性间的距离感、同辈/长辈的语气差异）；若我方性别未指定，则给出中性、不依赖性别的通用分寸
- 严格按以下三段输出（每段标题用【】括起）：
【关系定位】
（一句话定位你们大致是什么关系 / 怎么理解这个人）
【沟通分寸】
（和他沟通应注意的语气、距离感、避坑点，结合我方性别）
【破冰示例】
（一条可直接发的开场白，像真人聊天）`;
}

export async function generateContactInsight(input: {
  name: string;
  location: string;
  relation?: string;
  note?: string;
  me?: UserProfile;
}): Promise<{ raw: string; persona: string; advice: string; icebreaker: string }> {
  if (!input.name) throw new Error('联系人缺少姓名，无法生成画像');
  const sys = '你是人际关系顾问，只按用户要求的格式输出，不要任何多余解释。';
  const prompt = buildInsightPrompt(input);
  const text = await chatOnce(
    [
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ],
    { timeoutMs: 60000 },
  );
  const { persona, advice, icebreaker } = parseInsight(text);
  return { raw: text, persona, advice, icebreaker };
}

/** 解析 LLM 输出，按【关系定位】【沟通分寸】【破冰示例】三段归一化 */
export function parseInsight(text: string): {
  persona: string;
  advice: string;
  icebreaker: string;
} {
  const extract = (label: string): string => {
    const re = new RegExp(`【${label}】([\\s\\S]*?)(?=【|$)`);
    const m = text.match(re);
    return m ? m[1].replace(/^\s*[:：]\s*/, '').trim() : '';
  };
  return {
    persona: extract('关系定位'),
    advice: extract('沟通分寸'),
    icebreaker: extract('破冰示例'),
  };
}
