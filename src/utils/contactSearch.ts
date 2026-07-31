// 自然语言查找：把联系人（姓名 + 归属地 + 备注，**不含手机号**）编成编号列表发给 LLM，
// 让它按用户的自然语言查询挑出匹配者，返回匹配的联系人 id 列表。public / self 构建均可用。
//
// 设计边界（隐私）：
// - 只发送「姓名 + 归属地(由号段推导，非手机号 PII) + 用户自己的本地备注」；
// - 绝不发送手机号 / 邮箱原文、也不读取任何微信聊天记录。
import { chatOnce } from './llmClient';

export type SearchItem = {
  id: string;
  text: string; // 已拼好的紧凑描述，由调用方基于姓名/归属地/备注生成
};

/**
 * 按自然语言查询筛选联系人。
 * @param query 用户的一句话描述，如「上海的、做技术的朋友」
 * @param items 联系人紧凑列表（已脱敏，不含手机号）
 * @returns 匹配的联系人 id 数组（顺序无意义）
 */
export async function naturalSearch(
  query: string,
  items: SearchItem[],
): Promise<string[]> {
  if (!query.trim()) return [];
  if (items.length === 0) return [];

  const list = items
    .map((it, i) => `[${i}] ${it.text}`)
    .join('\n');

  const sys =
    '你是联系人筛选助手。根据用户的一句话查询，从下面带编号的联系人列表中，' +
    '挑出所有匹配的联系人。只输出一个 JSON 数组（如 [0,2,5]），不要任何解释或多余文字；' +
    '若都不匹配则输出 []。判断时结合姓名、归属地、备注进行合理推断。';

  const user =
    `查询：${query}\n\n` +
    `联系人列表：\n${list}\n\n` +
    '请只返回匹配的编号 JSON 数组：';

  const text = await chatOnce(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { timeoutMs: 60000 },
  );

  // parseIds 返回编号；映射回对应联系人 id 再返回
  return parseIds(text, items.length)
    .map((idx) => items[Number(idx)]?.id)
    .filter((x): x is string => !!x);
}

/** 从模型输出里抽取编号数组并映射回 id（鲁棒：容忍 ```json 包裹、前后多余文字） */
export function parseIds(raw: string, total: number): string[] {
  const m = raw.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const ids = new Set<string>();
  for (const x of arr) {
    const n = typeof x === 'number' ? x : parseInt(String(x), 10);
    if (Number.isInteger(n) && n >= 0 && n < total) ids.add(String(n));
  }
  return Array.from(ids);
}
