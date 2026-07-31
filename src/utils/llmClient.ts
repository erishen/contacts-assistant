// 极简 OpenAI 兼容客户端：chatOnce（单轮补全）+ testConnection（连通性实测）。
// 与 ai-workbench 桌面端一致：baseURL 末尾自动拼 /chat/completions，容忍带不带 /v1。
//
// 隐私说明：
// - API Key 仅存于系统安全存储（iOS Keychain / Android Keystore，见 llmSettings.ts 的 SecureStore），
//   不写入明文文件、不进入版本库、不出现在日志；
// - 发给模型的消息内容由调用方（如 ContactsScreen 的 AI 草稿）组装，本客户端不附加任何本地 PII；
// - 所有请求经由用户自配的 baseURL，不经过任何中间代理收集。
import { getActiveConfig } from './llmSettings';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function chatUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export async function chatOnce(
  messages: ChatMessage[],
  opts?: {
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const cfg = await getActiveConfig();
  if (!cfg) throw new Error('未配置模型，请先到「设置」添加');
  if (!cfg.apiKey) throw new Error(`配置「${cfg.label}」缺少 API Key`);

  const controller = new AbortController();
  // 合并外部中断信号（如切模型时主动 abort）与内部超时
  let externalAbort: (() => void) | null = null;
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else externalAbort = () => controller.abort();
  }
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 60000);
  try {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      stream: false,
    };
    if (typeof opts?.temperature === 'number') body.temperature = opts.temperature;
    if (typeof opts?.maxTokens === 'number') body.max_tokens = opts.maxTokens;
    const res = await fetch(chatUrl(cfg.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('响应缺少 choices[0].message.content');
    return content;
  } finally {
    clearTimeout(timer);
    if (externalAbort) opts?.signal?.removeEventListener('abort', externalAbort);
  }
}

export type TestResult = {
  ok: boolean;
  latencyMs: number;
  detail: string; // 成功=模型回复片段；失败=错误信息
};

/** 用给定参数（未必已保存）实测一次 /chat/completions */
export async function testConnection(params: {
  baseURL: string;
  model: string;
  apiKey: string;
}): Promise<TestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(chatUrl(params.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: '只回复两个字：正常' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, latencyMs, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    let reply = '';
    try {
      reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    } catch {
      /* ignore */
    }
    return { ok: true, latencyMs, detail: reply.slice(0, 50) || '(空回复)' };
  } catch (e: any) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: e?.name === 'AbortError' ? '超时（30s）' : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}
