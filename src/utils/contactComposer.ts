// 通用「AI 消息起草」：与微信完全解耦，public / self 构建都可使用。
//
// 设计边界（隐私 / 可分发）：
// - 只用到联系人「姓名」+「手机号归属地」（内置号段表 phoneMeta，非隐私 PII）
//   + 用户自定义的「本次目标 / 场景 / 关系称呼偏好」，不读取也不发送任何微信聊天记录；
// - 不使用私人语境 few-shot（对外包绝不含真实聊天范例）；仅内置一段
//   虚构的中性风格示例用于示范语气与格式；
// - 生成的草稿按联系人 id 落盘本机 AsyncStorage，可编辑 / 覆盖 / 跨会话保留，
//   但不存手机号等 PII（PII 仅存在于发给模型的提示词，不落本地）。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { chatOnce } from './llmClient';
import type { UserProfile } from './userProfile';

const genderLabel = (g?: UserProfile['gender']): string => {
  if (g === 'male') return '男';
  if (g === 'female') return '女';
  return '未指定（请勿假定，使用中性表述）';
};

/** 渠道无关的生成场景（不绑定微信） */
export const COMPOSE_KEYS = ['寒暄', '邀约', '问候', '致歉', '商务'] as const;
export const COMPOSE_CATALOG: Record<string, string> = {
  寒暄: '久未联系的轻松破冰，不带目的',
  邀约: '邀请对方吃饭 / 线下见面 / 活动，自然不油腻',
  问候: '节日或日常简短温暖问候',
  致歉: '因疏忽 / 爽约 / 迟到等表达歉意，诚恳得体',
  商务: '围绕合作、需求、资源对接的正式而亲切沟通',
};

export type ComposedDraft = {
  id: string; // 联系人 id
  name: string;
  goal: string;
  scenarios: string[];
  result: Record<string, string>;
  raw: string;
  savedAt: string; // ISO 时间戳
  relation?: string; // 用户填写的关系 / 称呼偏好（可选）
};

const keyOf = (id: string) => `compose.gen.${id}`;

export async function loadComposedDraft(id: string): Promise<ComposedDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(id));
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? (d as ComposedDraft) : null;
  } catch {
    return null;
  }
}

export async function saveComposedDraft(d: ComposedDraft): Promise<void> {
  await AsyncStorage.setItem(keyOf(d.id), JSON.stringify(d));
}

/** 清除全部已生成的通用草稿 */
export async function clearComposedDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter((k) => k.startsWith('compose.gen.'));
    if (targets.length) await AsyncStorage.multiRemove(targets);
  } catch {
    /* 忽略存储失败 */
  }
}

/** 组装发给模型的提示词（不含任何私人聊天记录） */
export function buildComposePrompt(input: {
  name: string;
  location: string;
  goal: string;
  scenarios: string[];
  relation?: string;
  note?: string;
  me?: UserProfile;
}): string {
  const { name, location, goal, scenarios, relation, note, me } = input;
  const scenarioLines = scenarios
    .map((s) => `- ${s}：${COMPOSE_CATALOG[s] ?? ''}`)
    .join('\n');
  // 输出格式示例（按选定场景逐行）
  const example = scenarios.map((s) => `${s}：<内容>`).join('\n');
  const meBlock = me
    ? `性别：${genderLabel(me.gender)}\n${
        me.selfName && me.selfName.trim() ? `希望被称呼为：${me.selfName.trim()}\n` : ''
      }`
    : `性别：未指定（请勿假定，使用中性表述）\n`;
  return `请根据下面联系人信息与本次目标，起草适合我（发起方）发送的消息（每条不超过 60 字，口语化、像真人聊天）。

【联系人信息】
姓名/备注：${name}
手机号归属地：${location || '未知'}
${relation ? `关系 / 称呼偏好：${relation}\n` : ''}
${(note && note.trim()) ? `本地备注：${note.trim()}\n` : ''}
【我方信息】
${meBlock}
${goal ? `【本次目标 / 上下文】\n${goal}\n` : ''}【需要生成的场景（严格按这些场景输出，不要增减）】
${scenarioLines}

【要求】
- 用恰当自然的称呼开头；称呼对方时用名字即可（姓可舍去，如对方叫张伟则称呼"伟"）；若不确定对方年龄或辈分，用名字或中性称呼，不要默认使用"哥""姐"等隐含对方年长含义的称呼
- 若提供了「关系 / 称呼偏好」，严格按该偏好称呼（如"李总""学妹""小王"），不要自行改用其他称呼
- 若我方提供了「希望被称呼为」（如"老王"），在需要自称或落款时优先用该称呼（例如文末署名"——老王"、或句中"我是老王"），不要编造其他自称；消息语气可结合我方性别自然调整（如异性间的分寸感），性别未指定则用中性表述
- 严格按以下格式输出（冒号用中文全角，每个场景一行）：
${example}

【风格示例（仅参考语气与分寸，不要照抄内容）】
寒暄：伟最近忙啥呢，好久没联系啦，最近还好吗？`;
}

export async function generateContactDraft(input: {
  name: string;
  location: string;
  goal: string;
  scenarios: string[];
  relation?: string;
  note?: string;
  me?: UserProfile;
}): Promise<{ raw: string; result: Record<string, string> }> {
  if (input.scenarios.length === 0) throw new Error('请至少选择一个生成场景');
  const sys = '你是消息撰写助手，只按用户要求的格式输出，不要任何多余解释。';
  const prompt = buildComposePrompt(input);
  const text = await chatOnce(
    [
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ],
    { timeoutMs: 60000 },
  );
  return { raw: text, result: parseCompose(text, input.scenarios) };
}

/** 解析 LLM 输出，按选定场景归一化为 { 场景: 内容 } */
export function parseCompose(
  text: string,
  scenarios: string[],
): Record<string, string> {
  const res: Record<string, string> = {};
  scenarios.forEach((s) => (res[s] = ''));
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of lines) {
    const m = l.match(/^([\u4e00-\u9fa5A-Za-z]{1,6})\s*[:：]/);
    const w = m?.[1];
    if (w && scenarios.includes(w)) {
      let after = l.split(/[:：]/).slice(1).join('：').trim();
      after = after.replace(/^\*+|\*+$/g, '').trim();
      if (after) res[w] = after;
    }
  }
  // 兜底：完全未匹配到场景标签时，按顺序把整段填进去
  const anyFilled = scenarios.some((s) => res[s]);
  if (!anyFilled && lines.length) {
    scenarios.forEach((s, i) => {
      if (lines[i]) res[s] = lines[i].replace(/^\*+|\*+$/g, '').trim();
    });
  }
  return res;
}
