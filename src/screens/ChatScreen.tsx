// 与 LLM 的普通聊天页：多轮对话，走「设置」里的主配置（getActiveConfig → chatOnce）。
// 会话内容持久化到 AsyncStorage（仅本机），长按气泡可复制。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { chatOnce, ChatMessage } from '../utils/llmClient';
import { getActiveConfig, onActiveConfigChange } from '../utils/llmSettings';
import { loadProfile, type UserProfile } from '../utils/userProfile';

type Bubble = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
};

const HISTORY_KEY = 'chat.history';
// 发给模型的最大历史条数（防 token 膨胀），显示不受限
const MAX_CONTEXT_MESSAGES = 30;
// 聊天专属生成参数：适度温度保留自然感，又不至于乱编
const CHAT_TEMPERATURE = 0.7;
const CHAT_MAX_TOKENS = 1024;
// 前置 system prompt：定角色、划边界（不碰私人数据、不乱编）、立输出规矩。
// 普通聊天刻意不接入通讯录/PII（隐私设计），因此明确告知模型「无上下文时不要编造」。
const SYSTEM_PROMPT = `你是一个运行在用户手机本地的「通讯录助手」App 内的中文对话助手。

# 你的定位
- 用简体中文回答，简洁、直接、有条理；复杂内容用要点或短段落呈现。
- 态度友好、专业，但不过度寒暄，不堆砌与请求无关的废话。

# 能力边界（非常重要）
- 你运行在本地，默认**无法访问**用户的通讯录、聊天记录、备注等任何私人数据。
- 若用户问及某个具体联系人的信息、历史聊天，或要求代写发给某人的消息，而对话中并没有相关上下文时，**如实说明你无法访问这些数据，绝对不要编造姓名、电话、聊天内容或人物关系**。
- 涉及「写给某联系人的消息」时，提醒用户可使用 App 内的「AI 起草 / AI 草稿」功能（那些功能会在用户授权下带入对应上下文）。

# 输出要求
- 不确定就说不确定；需要更多信息时，明确向用户追问。
- 不输出与请求无关的内容，不要在回答前加「作为 AI 助手」之类前缀。`;

// 把「设置 → 关于我」的用户自填资料拼进 system prompt。
// 注意：这是用户自己的资料（性别 / 希望被称呼），非第三方隐私，
// 且只在聊天上下文里使用，不进代码仓库、不随包发布（与 userProfile.ts 的设计一致）。
function buildMeSection(me: UserProfile | null): string {
  if (!me) return '';
  const parts: string[] = [];
  if (me.gender === 'male') parts.push('性别：男');
  else if (me.gender === 'female') parts.push('性别：女');
  const name = (me.selfName ?? '').trim();
  if (name) parts.push(`希望被称呼为：${name}`);
  if (parts.length === 0) return '';
  return `\n# 关于用户（我方）\n${parts.join('；')}。\n在合适的地方按此自称或被称呼，但无需每次提及。`;
}

let seq = 0;
const nextId = () => `m_${Date.now().toString(36)}_${seq++}`;

type Props = {
  /** 当前是否为激活 tab（App 采用隐藏不卸载策略，需靠它感知"切回来了"） */
  active?: boolean;
};

export default function ChatScreen({ active = true }: Props) {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [modelLabel, setModelLabel] = useState('');
  const listRef = useRef<FlatList<Bubble>>(null);
  // 请求序号：每次发送 +1，清空/切模型时 +1 作废在途请求，避免清空后回复「复活」会话
  const reqId = useRef(0);
  // 当前在途请求的 AbortController，用于切模型/清空时网络层立即中断
  const sendCtrl = useRef<AbortController | null>(null);

  // 启动：恢复历史 + 读当前模型标签
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(HISTORY_KEY);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) setMessages(list);
        }
      } catch {
        /* ignore */
      }
      refreshModelLabel();
    })();
  }, []);

  const refreshModelLabel = useCallback(async () => {
    const cfg = await getActiveConfig();
    setModelLabel(cfg ? `${cfg.label} · ${cfg.model}` : '未配置模型');
  }, []);

  // 每次切回聊天 tab 时重读主配置（用户可能刚在设置里切换了模型）
  useEffect(() => {
    if (active) refreshModelLabel();
  }, [active, refreshModelLabel]);

  // 设置页切换主模型时，立即中断在途 LLM 请求：作废序号 + 网络层 abort，
  // 避免用旧模型把回复写回、或切换时机卡巧用上新模型。
  useEffect(() => {
    return onActiveConfigChange(() => {
      reqId.current++;
      sendCtrl.current?.abort();
    });
  }, []);

  const persist = useCallback((list: Bubble[]) => {
    // 只保留最近 200 条，防止无限膨胀
    AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-200))).catch(
      () => {},
    );
  }, []);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    // 标记本次请求，清空/切模型后该序号失效，在途回复会被丢弃
    const myReq = ++reqId.current;
    // 作废上一次可能仍在途的请求，并新建本请求的 AbortController
    sendCtrl.current?.abort();
    const ctrl = new AbortController();
    sendCtrl.current = ctrl;
    // 每次发送时刷新模型标签（用户可能刚在设置里切了主配置）
    refreshModelLabel();

    const userMsg: Bubble = { id: nextId(), role: 'user', content: text };
    let base: Bubble[] = [];
    setMessages((prev) => {
      base = [...prev, userMsg];
      persist(base);
      return base;
    });
    scrollToEnd();

    try {
      // 组上下文：system（含「关于我」）+ 最近 N 条（不含错误气泡）
      const me = await loadProfile();
      const systemContent = SYSTEM_PROMPT + buildMeSection(me);
      const history: ChatMessage[] = base
        .filter((m) => !m.error)
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content }));
      const reply = await chatOnce(
        [{ role: 'system', content: systemContent }, ...history],
        {
          timeoutMs: 120000,
          temperature: CHAT_TEMPERATURE,
          maxTokens: CHAT_MAX_TOKENS,
          signal: ctrl.signal,
        },
      );
      if (reqId.current !== myReq) return; // 已被清空/新会话，丢弃在途回复
      setMessages((prev) => {
        const next: Bubble[] = [
          ...prev,
          { id: nextId(), role: 'assistant', content: reply },
        ];
        persist(next);
        return next;
      });
    } catch (e: any) {
      const detail =
        e?.name === 'AbortError' ? '请求超时（120s）' : String(e?.message ?? e);
      if (reqId.current !== myReq) return; // 已被清空/新会话，丢弃错误气泡
      setMessages((prev) => {
        const next: Bubble[] = [
          ...prev,
          { id: nextId(), role: 'assistant', content: `⚠️ ${detail}`, error: true },
        ];
        persist(next);
        return next;
      });
    } finally {
      setSending(false);
      scrollToEnd();
    }
  }, [input, sending, persist, refreshModelLabel, scrollToEnd]);

  const clearAll = useCallback(() => {
    if (messages.length === 0) return;
    Alert.alert('清空对话', '确定清空当前会话记录？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          reqId.current++; // 作废在途请求，防止清空后回复「复活」会话
          sendCtrl.current?.abort(); // 网络层立即中断
          setMessages([]);
          AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
        },
      },
    ]);
  }, [messages.length]);

  const copyBubble = useCallback(async (content: string) => {
    await Clipboard.setStringAsync(content);
    Alert.alert('已复制', content.slice(0, 60) + (content.length > 60 ? '…' : ''));
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* 顶栏 */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>聊天</Text>
          <Text style={styles.model} numberOfLines={1}>
            {modelLabel}
          </Text>
        </View>
        <TouchableOpacity style={styles.clearBtn} onPress={clearAll}>
          <Text style={styles.clearBtnText}>清空</Text>
        </TouchableOpacity>
      </View>

      {/* 消息列表 */}
      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyText}>
            开始对话吧{'\n'}模型走「设置」里的主配置
          </Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={scrollToEnd}
          renderItem={({ item }) => (
            <View
              style={[
                styles.row,
                item.role === 'user' ? styles.rowUser : styles.rowAssistant,
              ]}
            >
              <TouchableOpacity
                activeOpacity={0.8}
                onLongPress={() => copyBubble(item.content)}
                style={[
                  styles.bubble,
                  item.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                  item.error && styles.bubbleError,
                ]}
              >
                <Text
                  style={[
                    styles.bubbleText,
                    item.role === 'user' && styles.bubbleTextUser,
                    item.error && styles.bubbleTextError,
                  ]}
                  selectable
                >
                  {item.content}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      {/* 等待指示 */}
      {sending ? (
        <View style={styles.typing}>
          <ActivityIndicator size="small" color="#0a7ea4" />
          <Text style={styles.typingText}>思考中…</Text>
        </View>
      ) : null}

      {/* 输入栏 */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          placeholder="输入消息…"
          value={input}
          onChangeText={setInput}
          multiline
          editable={!sending}
          onSubmitEditing={send}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]}
          onPress={send}
          disabled={!input.trim() || sending}
        >
          <Text style={styles.sendBtnText}>发送</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f8fa' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  title: { fontSize: 20, fontWeight: '700' },
  model: { fontSize: 12, color: '#8a8f98', marginTop: 2 },
  clearBtn: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: '#e5e7eb',
  },
  clearBtnText: { fontSize: 13, color: '#374151' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { fontSize: 14, color: '#8a8f98', textAlign: 'center', lineHeight: 22 },
  listContent: { padding: 12, paddingBottom: 8 },
  row: { flexDirection: 'row', marginVertical: 4 },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '84%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  bubbleUser: { backgroundColor: '#0a7ea4', borderBottomRightRadius: 4 },
  bubbleAssistant: {
    backgroundColor: '#fff',
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
  },
  bubbleError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  bubbleText: { fontSize: 15, lineHeight: 22, color: '#111827' },
  bubbleTextUser: { color: '#fff' },
  bubbleTextError: { color: '#b91c1c' },
  typing: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  typingText: { fontSize: 12, color: '#8a8f98', marginLeft: 6 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 120,
    borderRadius: 19,
    backgroundColor: '#f1f3f5',
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 15,
  },
  sendBtn: {
    marginLeft: 8,
    borderRadius: 19,
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  sendBtnDisabled: { backgroundColor: '#a5c9d6' },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
