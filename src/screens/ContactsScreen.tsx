import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Contacts from 'expo-contacts';
import { Contact, ContactField } from 'expo-contacts';
import * as Clipboard from 'expo-clipboard';
import { getPhoneMeta } from '../utils/phoneMeta';
import { exportContactsCsv, CsvContact } from '../utils/exportCsv';
import { exportContactsProfile } from '../utils/exportProfile';
import { findWechat } from '../utils/wechatMatch';
import { findFollowupDraft, FollowupDraft } from '../utils/followupDrafts';
import {
  generateContactDraft,
  loadComposedDraft,
  saveComposedDraft,
  clearComposedDrafts,
  COMPOSE_KEYS,
  type ComposedDraft,
} from '../utils/contactComposer';
import {
  generateContactInsight,
  loadInsight,
  saveInsight,
  clearInsights,
  type ContactInsight,
} from '../utils/contactInsight';
import { WECHAT_FEATURES_ENABLED } from '../utils/wechatFeatureFlags';
import { loadNote, saveNote, loadAllNotes } from '../utils/contactNotes';
import { naturalSearch, type SearchItem } from '../utils/contactSearch';
import { loadProfile, type UserProfile } from '../utils/userProfile';
import { chatOnce } from '../utils/llmClient';
import {
  GeneratedDraft,
  loadGeneratedDraft,
  saveGeneratedDraft,
} from '../utils/generatedDrafts';
import {
  loadCachedContacts,
  saveContactsCache,
  subscribeContactsCache,
  consumeForceRefetch,
} from '../utils/contactsCache';

export type ContactItem = {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
};

type PermissionState = 'loading' | 'granted' | 'denied' | 'unsupported';

/** 每个联系人需要读取的字段 */
const FIELDS = [
  ContactField.FULL_NAME,
  ContactField.PHONES,
  ContactField.EMAILS,
] as const;

/**
 * 判断是否为手机号（中国大陆）：
 * 去掉空格/横线/括号等分隔符，兼容 +86 / 86 / 0086 前缀，
 * 匹配 1[3-9] 开头的 11 位数字。
 */
function isMobileNumber(raw: string): boolean {
  let digits = raw.replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+?86/, '').replace(/^0086/, '');
  return /^1[3-9]\d{9}$/.test(digits);
}

/** 归属地是否为上海（基于离线号段库；查不到归属地的号码视为不匹配） */
function isShanghaiNumber(raw: string): boolean {
  const meta = getPhoneMeta(raw);
  return !!meta && (meta.province === '上海' || meta.city === '上海');
}

/**
 * 从姓名/微信备注里抽取单位或关系后缀（如「陈佳杰-携程」「Sunny Sun - Paypal」→ 携程/Paypal）。
 * 匹配最后一个分隔符（- _ － —）之后的非空白串（2~20 字，非纯数字）。
 */
function extractCompany(raw: string): string {
  const m = raw.match(/[-_－—]\s*([\u4e00-\u9fa5A-Za-z0-9]{2,20})$/);
  if (!m) return '';
  const v = m[1];
  return /^\d+$/.test(v) ? '' : v;
}

/** 去掉行首 markdown / 编号噪声（** 粗体、- 列表、> 引用、1. 编号），便于匹配标签 */
function stripLinePrefix(line: string): string {
  let s = line.trim();
  s = s.replace(/^\s*\**\s*/, ''); // 粗体 ** / *
  s = s.replace(/^>\s?/, ''); // 引用
  s = s.replace(/^[-•·]\s+/, ''); // 无序列表
  s = s.replace(/^[（(]?\d+[）)、.]\s*/, ''); // 有序编号 1. 1、 (1)
  return s.trim();
}

/** 从一行识别场景标签（寒暄/内推/问候 + 常见同义），返回归一化 key */
function labelOf(line: string): '寒暄' | '内推' | '问候' | '群邀请' | null {
  const cleaned = stripLinePrefix(line);
  // 标签与冒号之间允许 0~2 个 *（容忍 **寒暄**： 这类 markdown 粗体闭合）
  const m = cleaned.match(/^([\u4e00-\u9fa5A-Za-z]{1,4})\s*\*?\*?[：:]/);
  if (!m) return null;
  const w = m[1];
  if (['寒暄', '破冰', '打招呼', '问好'].includes(w)) return '寒暄';
  if (['内推', '推荐', '引荐'].includes(w)) return '内推';
  if (['问候', '关心', '祝'].includes(w)) return '问候';
  if (['群邀请', '入群', '拉群', '建群', '邀请'].includes(w)) return '群邀请';
  return null;
}

/**
 * 解析 LLM 返回的草稿：
 * - 优先匹配「标签：内容」同行；
 * - 标签行内容为空时，取下一行作为内容（适配 **寒暄**：\n内容 写法）；
 * - 都不匹配时，按行顺序兜底切 3 段。
 */
function parseDrafts(text: string): Record<'寒暄' | '内推' | '问候' | '群邀请', string> {
  const res: Record<'寒暄' | '内推' | '问候' | '群邀请', string> = {
    寒暄: '',
    内推: '',
    问候: '',
    群邀请: '',
  };
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 第一遍：标签与内容同行
  for (const l of lines) {
    const k = labelOf(l);
    if (!k) continue;
    let after = stripLinePrefix(l)
      .split(/[：:]/)
      .slice(1)
      .join('：')
      .trim();
    after = after.replace(/^\*+|\*+$/g, '').trim(); // 去内容首尾残留的粗体标记
    if (after) res[k] = after;
  }

  // 第二遍：标签行内容为空，取下一行
  if (!res.寒暄 || !res.内推 || !res.问候 || !res.群邀请) {
    for (let i = 0; i < lines.length; i++) {
      const k = labelOf(lines[i]);
      if (k && !res[k]) {
        const next = stripLinePrefix(lines[i + 1] ?? '');
        if (next && !labelOf(next)) res[k] = next;
      }
    }
  }

  // 兜底：所有标签都为空时，按顺序切前 4 段
  if (!res.寒暄 && !res.内推 && !res.问候 && !res.群邀请) {
    const keys: Array<'寒暄' | '内推' | '问候' | '群邀请'> = ['寒暄', '内推', '问候', '群邀请'];
    keys.forEach((k, i) => {
      if (lines[i]) res[k] = stripLinePrefix(lines[i]);
    });
  }
  return res;
}

/**
 * 组装「身份 + 草稿」一体化复制文本：
 * 第一行姓名，第二行微信（如有），空行后接草稿正文。
 * 便于一次复制后即可整体粘贴到备忘录或微信对话。
 */
function buildDraftBundle(
  name: string,
  wx: { name: string; wxid: string } | null,
  body: string,
): string {
  const lines: string[] = [name];
  if (wx) {
    lines.push(
      `微信：${wx.wxid}${wx.name !== name ? `（备注：${wx.name}）` : ''}`,
    );
  }
  lines.push('', body);
  return lines.join('\n');
}

/** 是否与该联系人聊过天（命中离线预生成草稿即有历史聊天） */
function hasChatHistory(name: string): boolean {
  if (!WECHAT_FEATURES_ENABLED) return false;
  const wx = findWechat(name);
  return wx ? !!findFollowupDraft(wx.wxid) : false;
}

/** 跟进场景目录：键=场景名，值=给模型的场景说明 */
const GEN_KEYS = ['寒暄', '内推', '问候', '群邀请'] as const;
const SCENARIO_CATALOG: Record<string, string> = {
  寒暄: '久未联系的轻松破冰，不带目的',
  内推: '求职内推请求（我正在寻找新的职业机会，希望对方帮忙内推或引荐，真诚不卑不亢）',
  问候: '节日/日常简短温暖问候',
  群邀请: '我正在组建一个关于 AI 技术行业趋势与实战想法的小众交流群，无广告、氛围轻松。写一条向对方发出的入群邀请——先征得对方同意再拉群：用「想拉你进来 / 你方便的话我拉你」这类由「我」来加的话，但不要不打招呼直接拉，也不要说「私信我 / 联系我 / 感兴趣来找我」把动作推回给对方。自然不油腻、不强推、体现温度',
};

/** 卡片上的备注徽标：检测本机是否已有备注，显示「已备注 / 备注」 */
function NoteBadge({ id, onPress }: { id: string; onPress: () => void }) {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let active = true;
    loadNote(id).then((n) => {
      if (active) setHas(!!(n && n.trim()));
    });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <TouchableOpacity
      style={{
        backgroundColor: has ? '#e8f0fe' : '#f3f4f6',
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 5,
      }}
      onPress={onPress}
    >
      <Text style={{ fontSize: 13, color: has ? '#1a56db' : '#6b7280' }}>
        {has ? '📝 已备注' : '📝 备注'}
      </Text>
    </TouchableOpacity>
  );
}

export default function ContactsScreen() {
  const [permission, setPermission] = useState<PermissionState>('loading');
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [shanghaiOnly, setShanghaiOnly] = useState(true);

  const loadContacts = useCallback(async (opts?: { force?: boolean }) => {
    // 非强制时优先读缓存（冷启动秒开，避免每次都走设备 API）
    if (!opts?.force) {
      const cached = await loadCachedContacts();
      if (cached) {
        setContacts(cached);
        return;
      }
    }
    setLoading(true);
    try {
      // SDK 57 新 OO API：getAll 返回 Contact 实例列表，详情按需读取
      const all = await Contact.getAll();
      const items = await Promise.all(
        all.map(async (c): Promise<ContactItem> => {
          const details = await c.getDetails(FIELDS);
          return {
            id: c.id,
            name: details.fullName || '(无姓名)',
            // 只保留手机号，座机/400/短号等全部过滤
            phones: (details.phones ?? [])
              .map((p) => p.number ?? '')
              .filter(isMobileNumber),
            emails: (details.emails ?? [])
              .map((e) => e.address ?? '')
              .filter(Boolean),
          };
        }),
      );
      // 手机号级去重：Android 多账户同步常使同一号码散落在多条通讯录记录，
      // 导致同一手机号在列表里出现多次。这里按归一化号码合并为单卡。
      const normKey = (raw: string): string => {
        let d = raw.replace(/[^\d+]/g, '').replace(/^\+?86/, '').replace(/^0086/, '');
        return /^1[3-9]\d{9}$/.test(d) ? d : '';
      };
      const bestName = (a: string, b: string): string => {
        const na = a === '(无姓名)' ? '' : a;
        const nb = b === '(无姓名)' ? '' : b;
        if (!na) return nb || a;
        if (!nb) return na;
        return a.length >= b.length ? a : b;
      };
      // 每个归一化号码唯一归属一张主卡：以主卡 id 为键维护 canons，
      // byPhone 仅用于合并期查找。任何一张卡命中多个主卡时，先把它们
      // 互相合并并删除被吸收的旧卡，保证同一号码/同一个人绝不重复出现。
      const byPhone = new Map<string, string>(); // normKey -> 主卡 id
      const canons = new Map<string, ContactItem>(); // 主卡 id -> ContactItem

      const mergeInto = (target: ContactItem, src: ContactItem): void => {
        const targetKeys = new Set(target.phones.map(normKey));
        const extra = src.phones.filter((p) => !targetKeys.has(normKey(p)));
        target.phones = [...target.phones, ...extra];
        target.emails = Array.from(new Set([...target.emails, ...src.emails]));
        target.name = bestName(target.name, src.name);
        for (const p of target.phones) byPhone.set(normKey(p), target.id);
      };

      for (const c of items) {
        // 单卡内同号去重（含不同格式的同号，如 138-0000-0000 与 138 0000 0000）
        const seenInCard = new Set<string>();
        const phones: string[] = [];
        for (const p of c.phones) {
          const k = normKey(p);
          if (!k) continue; // 双保险：非手机号跳过
          if (seenInCard.has(k)) continue;
          seenInCard.add(k);
          phones.push(p);
        }
        if (phones.length === 0) continue;
        // 该卡命中的已有主卡
        const hitIds = new Set<string>();
        for (const p of phones) {
          const id = byPhone.get(normKey(p));
          if (id) hitIds.add(id);
        }
        if (hitIds.size === 0) {
          const rec: ContactItem = { ...c, phones };
          for (const p of phones) byPhone.set(normKey(p), rec.id);
          canons.set(rec.id, rec);
        } else {
          const ids = Array.from(hitIds);
          const primary = canons.get(ids[0])!;
          // 命中多个主卡：先把其它主卡并入 primary 并删除
          for (let i = 1; i < ids.length; i++) {
            const other = canons.get(ids[i])!;
            mergeInto(primary, other);
            canons.delete(ids[i]);
          }
          // 再把当前卡并入 primary
          mergeInto(primary, { ...c, phones });
        }
      }
      // 没有手机号的联系人不展示
      const mobileOnly = Array.from(canons.values()).filter((c) => c.phones.length > 0);
      // 预计算「是否有历史聊天草稿」，用于排序（有聊天的排前面）
      const hasDraft = new Map<string, boolean>();
      for (const c of mobileOnly) {
        const wx = WECHAT_FEATURES_ENABLED ? findWechat(c.name) : null;
        hasDraft.set(c.id, wx ? !!findFollowupDraft(wx.wxid) : false);
      }
      mobileOnly.sort((a, b) => {
        const ad = hasDraft.get(a.id) ? 1 : 0;
        const bd = hasDraft.get(b.id) ? 1 : 0;
        if (ad !== bd) return bd - ad; // 有聊天记录的排前
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      setContacts(mobileOnly);
      await saveContactsCache(mobileOnly);
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (Platform.OS === 'web') {
      setPermission('unsupported');
      return;
    }
    const { status } = await Contacts.requestPermissionsAsync();
    if (status === 'granted') {
      setPermission('granted');
      await loadContacts();
    } else {
      setPermission('denied');
    }
  }, [loadContacts]);

  useEffect(() => {
    requestPermission();
  }, [requestPermission]);

  // 订阅设置页的「清除缓存 / 重新获取最新」信号（本页在切 tab 时仍挂载、仅隐藏）
  useEffect(() => {
    const unsub = subscribeContactsCache(async () => {
      if (consumeForceRefetch()) {
        await loadContacts({ force: true });
      }
    });
    return unsub;
  }, [loadContacts]);

  // 归属地过滤：只保留上海号码；无上海号码的联系人整条不展示
  const regionFiltered = useMemo(() => {
    if (!shanghaiOnly) return contacts;
    return contacts
      .map((c) => ({ ...c, phones: c.phones.filter(isShanghaiNumber) }))
      .filter((c) => c.phones.length > 0);
  }, [contacts, shanghaiOnly]);

  const [wechatOnly, setWechatOnly] = useState(true);

  // 微信过滤：只保留匹配到微信好友的联系人（对外发布包不含微信数据，wechatOnly 视为无效）
  const wechatFiltered = useMemo(() => {
    if (!WECHAT_FEATURES_ENABLED || !wechatOnly) return regionFiltered;
    return regionFiltered.filter((c) => findWechat(c.name) !== null);
  }, [regionFiltered, wechatOnly]);

  // 聊天状态过滤：全部 / 最近聊过（有历史跟进草稿）/ 没聊过（对外发布包跳过，恒为全部）
  const [chatFilter, setChatFilter] = useState<'all' | 'chatted' | 'notChatted'>(
    'all',
  );
  const chatFiltered = useMemo(() => {
    if (!WECHAT_FEATURES_ENABLED) return wechatFiltered;
    if (chatFilter === 'all') return wechatFiltered;
    return wechatFiltered.filter((c) =>
      chatFilter === 'chatted'
        ? hasChatHistory(c.name)
        : !hasChatHistory(c.name),
    );
  }, [wechatFiltered, chatFilter]);

  // 智能查找命中的 ids（在 filtered 之前声明，供下方 useMemo 依赖）
  const [smart, setSmart] = useState<{ query: string; ids: string[] } | null>(null);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list = chatFiltered;
    if (kw) {
      list = list.filter((c) => {
        const wx = WECHAT_FEATURES_ENABLED ? findWechat(c.name) : null;
        return (
          c.name.toLowerCase().includes(kw) ||
          c.phones.some((p) => p.replace(/[\s-]/g, '').includes(kw)) ||
          c.emails.some((e) => e.toLowerCase().includes(kw)) ||
          (wx?.wxid ?? '').toLowerCase().includes(kw)
        );
      });
    }
    if (smart) {
      const set = new Set(smart.ids);
      list = list.filter((c) => set.has(c.id));
    }
    return list;
  }, [chatFiltered, keyword, smart]);

  // ===== 自然语言查找（LLM 理解筛选意图，基于姓名/归属地/备注）=====
  const [smartModal, setSmartModal] = useState(false);
  const [smartQuery, setSmartQuery] = useState('');
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartError, setSmartError] = useState('');
  const [smartResult, setSmartResult] = useState<{ id: string; name: string }[] | null>(null);

  const openSmart = useCallback(() => {
    setSmartQuery('');
    setSmartError('');
    setSmartResult(null);
    setSmartModal(true);
  }, []);

  const runSmart = useCallback(async () => {
    const q = smartQuery.trim();
    if (!q) {
      setSmartError('请描述要找的人，如：上海的、做技术的朋友');
      return;
    }
    setSmartLoading(true);
    setSmartError('');
    setSmartResult(null);
    try {
      const notes = await loadAllNotes();
      const items: SearchItem[] = contacts.map((c) => {
        const meta = getPhoneMeta(c.phones[0] ?? '');
        const loc =
          meta && (meta.province || meta.city)
            ? meta.province && meta.city && meta.province !== meta.city
              ? `${meta.province}·${meta.city}`
              : meta.province || meta.city
            : '未知';
        const note = notes[c.id] || '';
        return { id: c.id, text: `姓名:${c.name} | 归属地:${loc} | 备注:${note || '无'}` };
      });
      const ids = await naturalSearch(q, items);
      const byId = new Map(contacts.map((c) => [c.id, c.name]));
      setSmartResult(ids.map((id) => ({ id, name: byId.get(id) ?? '?' })));
    } catch (e) {
      setSmartError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmartLoading(false);
    }
  }, [smartQuery, contacts]);

  const applySmart = useCallback(() => {
    if (!smartResult || smartResult.length === 0) {
      setSmartError('没有匹配的联系人，换个说法试试');
      return;
    }
    setSmart({ query: smartQuery.trim(), ids: smartResult.map((r) => r.id) });
    setSmartModal(false);
  }, [smartResult, smartQuery]);

  const clearSmart = useCallback(() => setSmart(null), []);

  const [exporting, setExporting] = useState(false);
  const [exportingProfile, setExportingProfile] = useState(false);

  // AI 跟进草稿（选联系人 → 弹层生成多种语气消息）
  const [draftFor, setDraftFor] = useState<ContactItem | null>(null);
  const [draftData, setDraftData] = useState<Record<
    '寒暄' | '内推' | '问候' | '群邀请',
    string
  > | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftRaw, setDraftRaw] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  // 离线预生成草稿（基于历史聊天，无需联网）：命中 wxid 时优先展示
  const [preDraft, setPreDraft] = useState<FollowupDraft | null>(null);
  // 在线生成：本次目标 + 勾选场景 + 是否已保存到本机
  const [genGoal, setGenGoal] = useState('');
  const [genScenarios, setGenScenarios] = useState<string[]>(GEN_KEYS as unknown as string[]);
  const [genSavedAt, setGenSavedAt] = useState<string | null>(null);

  const openDraft = useCallback((c: ContactItem) => {
    setDraftFor(c);
    setDraftData(null);
    setDraftError('');
    setDraftRaw('');
    setShowRaw(false);
    setGenGoal('');
    setGenScenarios(GEN_KEYS as unknown as string[]);
    setGenSavedAt(null);
    const wx = WECHAT_FEATURES_ENABLED ? findWechat(c.name) : null;
    setPreDraft(wx ? findFollowupDraft(wx.wxid) : null);
    // 载入已保存的在线生成草稿（按 wxid 落盘，跨会话保留）
    if (wx) {
      loadGeneratedDraft(wx.wxid).then((g) => {
        if (g) {
          setGenGoal(g.goal || '');
          setGenScenarios(g.scenarios?.length ? g.scenarios : (GEN_KEYS as unknown as string[]));
          setDraftData(g.result);
          setDraftRaw(g.raw || '');
          setGenSavedAt(g.savedAt);
        }
      });
    }
  }, []);

  const generateDraft = useCallback(
    async (c: ContactItem, goal: string, scenarios: string[]) => {
      if (scenarios.length === 0) {
        setDraftError('请至少选择一个生成场景');
        return;
      }
      setDraftLoading(true);
      setDraftError('');
      try {
        const wx = WECHAT_FEATURES_ENABLED ? findWechat(c.name) : null;
        const company =
          extractCompany(c.name) ||
          (wx ? extractCompany(wx.name) : '');
        const meta = getPhoneMeta(c.phones[0] ?? '');
        const location =
          meta && (meta.province || meta.city)
            ? meta.province && meta.city && meta.province !== meta.city
              ? `${meta.province}·${meta.city}`
              : meta.province || meta.city
            : '未知';
        const hasWx = wx ? '已加微信（可直接发送）' : '未加微信';
        // 离线预生成草稿（基于该联系人真实历史聊天）作为 few-shot 范例，风格更贴人
        const pre = wx ? findFollowupDraft(wx.wxid) : null;
        const fewShot = pre
          ? `\n【参考风格示例：该联系人基于历史聊天的真实跟进草稿，请模仿其语气与分寸】\n${pre.draft}\n`
          : '';
        const scenarioLines = scenarios
          .map((s) => `- ${s}：${SCENARIO_CATALOG[s]}`)
          .join('\n');
        const sys =
          '你是人脉维护助手，只按用户要求的格式输出，不要任何多余解释。';
        const prompt = `请根据下面联系人信息与本次目标，起草适合在微信发送的消息（每条不超过 60 字，口语化、像真人聊天）。

【联系人信息】
姓名/备注：${c.name}
推断单位/关系：${company || '未知'}
手机号归属地：${location}
是否已加微信：${hasWx}
${goal ? `【本次目标 / 上下文】\n${goal}\n` : ''}
【需要生成的场景（严格按这些场景输出，不要增减）】
${scenarioLines}
${fewShot}
【要求】
- 用自然亲切的称呼开头（根据姓氏推断，如"王哥""李姐"；不确定性别用全名）
- 严格按以下格式输出（冒号用中文全角，每个场景一行）：
${scenarios.map((s) => `${s}：<内容>`).join('\n')}`;
        const text = await chatOnce(
          [
            { role: 'system', content: sys },
            { role: 'user', content: prompt },
          ],
          { timeoutMs: 60000 },
        );
        setDraftRaw(text);
        setDraftData(parseDrafts(text));
      } catch (e) {
        setDraftError(e instanceof Error ? e.message : String(e));
      } finally {
        setDraftLoading(false);
      }
    },
    [],
  );

  const toggleScenario = useCallback((s: string) => {
    setGenScenarios((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);

  const saveGenerated = useCallback(async () => {
    if (!draftFor) return;
    const wx = WECHAT_FEATURES_ENABLED ? findWechat(draftFor.name) : null;
    if (!wx || !draftData) {
      Alert.alert('无可保存内容', '请先生成草稿再保存');
      return;
    }
    const savedAt = new Date().toISOString();
    const rec: GeneratedDraft = {
      wxid: wx.wxid,
      goal: genGoal,
      scenarios: genScenarios,
      result: draftData,
      raw: draftRaw,
      savedAt,
    };
    await saveGeneratedDraft(rec);
    setGenSavedAt(savedAt);
    Alert.alert('已保存', '该联系人的生成草稿已存到本机，下次打开仍在');
  }, [draftFor, genGoal, genScenarios, draftData, draftRaw]);

  // ===== 通用 AI 消息起草（与微信彻底解耦，public / self 构建均可使用）=====
  const [me, setMe] = useState<UserProfile | null>(null);
  useEffect(() => {
    loadProfile().then(setMe);
  }, []);
  const [composeFor, setComposeFor] = useState<ContactItem | null>(null);
  const [composeGoal, setComposeGoal] = useState('');
  const [composeScenarios, setComposeScenarios] = useState<string[]>(
    COMPOSE_KEYS as unknown as string[],
  );
  const [composeData, setComposeData] = useState<Record<string, string> | null>(null);
  const [composeRaw, setComposeRaw] = useState('');
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeError, setComposeError] = useState('');
  const [composeSavedAt, setComposeSavedAt] = useState<string | null>(null);
  const [composeRelation, setComposeRelation] = useState('');

  // ===== 通用 AI 联系人画像（与微信解耦，public / self 构建均可使用）=====
  const [insightFor, setInsightFor] = useState<ContactItem | null>(null);
  const [insightRelation, setInsightRelation] = useState('');
  const [insightData, setInsightData] = useState<{
    persona: string;
    advice: string;
    icebreaker: string;
  } | null>(null);
  const [insightRaw, setInsightRaw] = useState('');
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightError, setInsightError] = useState('');
  const [insightSavedAt, setInsightSavedAt] = useState<string | null>(null);

  const openInsight = useCallback((c: ContactItem) => {
    setInsightFor(c);
    setInsightRelation('');
    setInsightData(null);
    setInsightRaw('');
    setInsightError('');
    setInsightSavedAt(null);
    // 载入本机已保存的画像（按联系人 id 落盘，跨会话保留）
    loadInsight(c.id).then((g) => {
      if (g) {
        setInsightRelation(g.relation || '');
        setInsightData({
          persona: g.persona,
          advice: g.advice,
          icebreaker: g.icebreaker,
        });
        setInsightRaw(g.raw || '');
        setInsightSavedAt(g.savedAt);
      }
    });
  }, []);

  const generateInsight = useCallback(
    async (c: ContactItem) => {
      setInsightLoading(true);
      setInsightError('');
      try {
        const meta = getPhoneMeta(c.phones[0] ?? '');
        const location =
          meta && (meta.province || meta.city)
            ? meta.province && meta.city && meta.province !== meta.city
              ? `${meta.province}·${meta.city}`
              : meta.province || meta.city
            : '未知';
        const note = (await loadNote(c.id)) || '';
        const { raw, persona, advice, icebreaker } = await generateContactInsight({
          name: c.name,
          location,
          relation: insightRelation,
          note,
          me: me ?? undefined,
        });
        setInsightRaw(raw);
        setInsightData({ persona, advice, icebreaker });
      } catch (e) {
        setInsightError(e instanceof Error ? e.message : String(e));
      } finally {
        setInsightLoading(false);
      }
    },
    [insightRelation, me],
  );

  const saveInsightRec = useCallback(async () => {
    if (!insightFor || !insightData) {
      Alert.alert('无可保存内容', '请先生成画像再保存');
      return;
    }
    const savedAt = new Date().toISOString();
    const rec: ContactInsight = {
      id: insightFor.id,
      name: insightFor.name,
      raw: insightRaw,
      persona: insightData.persona,
      advice: insightData.advice,
      icebreaker: insightData.icebreaker,
      savedAt,
      relation: insightRelation,
    };
    await saveInsight(rec);
    setInsightSavedAt(savedAt);
    Alert.alert('已保存', '该联系人的 AI 画像已存到本机，下次打开仍在');
  }, [insightFor, insightData, insightRaw, insightRelation]);

  // ===== 本地联系人备注（仅本机，不读微信，生成起草 / 画像时作为上下文）=====
  const [noteFor, setNoteFor] = useState<ContactItem | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteSavedAt, setNoteSavedAt] = useState<string | null>(null);

  const openNote = useCallback((c: ContactItem) => {
    setNoteFor(c);
    setNoteText('');
    setNoteSavedAt(null);
    loadNote(c.id).then((n) => {
      if (n && n.trim()) {
        setNoteText(n);
      }
    });
  }, []);

  const saveNoteRec = useCallback(async () => {
    if (!noteFor) return;
    await saveNote(noteFor.id, noteText);
    setNoteSavedAt(new Date().toISOString());
    Alert.alert('已保存', '备注已存到本机，生成 AI 起草 / 画像时会作为上下文');
  }, [noteFor, noteText]);

  const clearNoteRec = useCallback(async () => {
    if (!noteFor) return;
    await saveNote(noteFor.id, '');
    setNoteText('');
    setNoteSavedAt(null);
    Alert.alert('已清除', '该联系人的本地备注已删除');
  }, [noteFor]);

  const openCompose = useCallback((c: ContactItem) => {
    setComposeFor(c);
    setComposeGoal('');
    setComposeRelation('');
    setComposeScenarios(COMPOSE_KEYS as unknown as string[]);
    setComposeData(null);
    setComposeRaw('');
    setComposeError('');
    setComposeSavedAt(null);
    // 载入本机已保存的通用草稿（按联系人 id 落盘，跨会话保留）
    loadComposedDraft(c.id).then((g) => {
      if (g) {
        setComposeGoal(g.goal || '');
        setComposeRelation(g.relation || '');
        setComposeScenarios(
          g.scenarios?.length ? g.scenarios : (COMPOSE_KEYS as unknown as string[]),
        );
        setComposeData(g.result);
        setComposeRaw(g.raw || '');
        setComposeSavedAt(g.savedAt);
      }
    });
  }, []);

  const toggleComposeScenario = useCallback((s: string) => {
    setComposeScenarios((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);

  const generateCompose = useCallback(
    async (c: ContactItem) => {
      if (composeScenarios.length === 0) {
        setComposeError('请至少选择一个生成场景');
        return;
      }
      setComposeLoading(true);
      setComposeError('');
      try {
        const meta = getPhoneMeta(c.phones[0] ?? '');
        const location =
          meta && (meta.province || meta.city)
            ? meta.province && meta.city && meta.province !== meta.city
              ? `${meta.province}·${meta.city}`
              : meta.province || meta.city
            : '未知';
        const note = (await loadNote(c.id)) || '';
        const { raw, result } = await generateContactDraft({
          name: c.name,
          location,
          goal: composeGoal,
          scenarios: composeScenarios,
          relation: composeRelation,
          note,
          me: me ?? undefined,
        });
        setComposeRaw(raw);
        setComposeData(result);
      } catch (e) {
        setComposeError(e instanceof Error ? e.message : String(e));
      } finally {
        setComposeLoading(false);
      }
    },
    [composeGoal, composeScenarios, me],
  );

  const saveCompose = useCallback(async () => {
    if (!composeFor || !composeData) {
      Alert.alert('无可保存内容', '请先生成草稿再保存');
      return;
    }
    const savedAt = new Date().toISOString();
    const rec: ComposedDraft = {
      id: composeFor.id,
      name: composeFor.name,
      goal: composeGoal,
      scenarios: composeScenarios,
      result: composeData,
      raw: composeRaw,
      savedAt,
      relation: composeRelation,
    };
    await saveComposedDraft(rec);
    setComposeSavedAt(savedAt);
    Alert.alert('已保存', '该联系人的生成草稿已存到本机，下次打开仍在');
  }, [composeFor, composeGoal, composeScenarios, composeData, composeRaw, composeRelation]);

  const copyComposeAll = useCallback(() => {
    if (!composeData) return;
    const body = composeScenarios
      .filter((k) => composeData[k])
      .map((k) => `${k}：${composeData[k]}`)
      .join('\n\n');
    // copyText 在本函数之后定义，但它是稳定的 useCallback，调用时已初始化；
    // 不放进依赖数组以避免渲染期 TDZ（used-before-declaration）。
    copyText(`${composeFor?.name ?? ''}\n\n${body}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeFor, composeData, composeScenarios]);

  const copyText = useCallback(async (t: string) => {
    try {
      await Clipboard.setStringAsync(t);
      Alert.alert('已复制', '可粘贴到微信发送');
    } catch {
      /* ignore */
    }
  }, []);

  const copyAll = useCallback(
    (data: Record<'寒暄' | '内推' | '问候' | '群邀请', string>) => {
      const body = (['寒暄', '内推', '问候', '群邀请'] as const)
        .filter((k) => data[k])
        .map((k) => `${k}：${data[k]}`)
        .join('\n\n');
      const wx = draftFor && WECHAT_FEATURES_ENABLED ? findWechat(draftFor.name) : null;
      copyText(buildDraftBundle(draftFor?.name ?? '', wx, body));
    },
    [copyText, draftFor],
  );

  /** 导出当前筛选结果为 CSV（一行一个手机号） */
  /**
   * 跳微信聊天：微信不开放"直达某人聊天"的深链，
   * 通用做法 = 复制搜索关键词 + 打开微信，用户在微信搜索框粘贴即达。
   * 注意：原始 wxid_ 在微信里搜不到，此时复制备注名（已是好友，搜备注名可直达对话）。
   */
  const openWechat = useCallback(
    async (
      wx: { name: string; wxid: string },
      copyTextOverride?: string,
    ) => {
      const searchKey = wx.wxid.startsWith('wxid_') ? wx.name : wx.wxid;
      const toCopy = copyTextOverride ?? searchKey;
      try {
        await Clipboard.setStringAsync(toCopy);
      } catch {
        // 复制失败不阻断跳转
      }
      Alert.alert(
        copyTextOverride ? '已复制草稿' : `已复制「${searchKey}」`,
        copyTextOverride
          ? `打开微信后，搜索「${searchKey}」找到对话，粘贴即可发送`
          : '打开微信后，在顶部搜索框粘贴即可找到对话',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '打开微信',
            onPress: () =>
              Linking.openURL('weixin://').catch(() =>
                Alert.alert('无法打开微信', '可能未安装微信，或系统限制了跳转'),
              ),
          },
        ],
      );
    },
    [],
  );

  const handleExport = useCallback(async () => {
    if (filtered.length === 0) {
      Alert.alert('没有可导出的联系人');
      return;
    }
    setExporting(true);
    try {
      const rows: CsvContact[] = [];
      for (const c of filtered) {
        const wx = WECHAT_FEATURES_ENABLED ? findWechat(c.name) : null;
        for (const p of c.phones) {
          const meta = getPhoneMeta(p);
          rows.push({
            name: c.name,
            phone: p,
            province: meta?.province ?? '',
            city: meta?.city ?? '',
            operator: meta?.operator ?? '',
            emails: c.emails.join('; '),
            wechatName: wx?.name ?? '',
            wechatId: wx?.wxid ?? '',
          });
        }
      }
      await exportContactsCsv(rows);
    } catch (err) {
      Alert.alert('导出失败', err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [filtered]);

  /** 导出当前筛选结果为「联系人档案」Markdown（备注 + AI 画像 + AI 草稿），走系统分享 */
  const handleExportProfile = useCallback(async () => {
    if (filtered.length === 0) {
      Alert.alert('没有可导出的联系人');
      return;
    }
    setExportingProfile(true);
    try {
      await exportContactsProfile(filtered);
    } catch (err) {
      Alert.alert('导出失败', err instanceof Error ? err.message : String(err));
    } finally {
      setExportingProfile(false);
    }
  }, [filtered]);

  if (permission === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.hint}>正在请求通讯录权限…</Text>
      </View>
    );
  }

  if (permission === 'unsupported') {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>
          Web 端不支持读取通讯录，请在 iOS / Android 设备（Expo Go）上运行。
        </Text>
      </View>
    );
  }

  if (permission === 'denied') {
    return (
      <View style={styles.center}>
        <Text style={styles.hint}>未获得通讯录权限</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>重新请求权限</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary]}
          onPress={() => Linking.openSettings()}
        >
          <Text style={styles.buttonText}>去系统设置开启</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const draftWx = draftFor && WECHAT_FEATURES_ENABLED ? findWechat(draftFor.name) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>
            通讯录
          </Text>
          <Text style={styles.titleCount} numberOfLines={1}>
            （{filtered.length}/{contacts.length}）
          </Text>
        </View>
        <View style={styles.exportGroup}>
          <TouchableOpacity
            style={[styles.toggle, styles.exportBtn]}
            onPress={handleExport}
            disabled={exporting}
          >
            <Text style={[styles.toggleText, styles.toggleTextActive]}>
              {exporting ? '导出中…' : '导出 CSV'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggle, styles.exportBtn]}
            onPress={handleExportProfile}
            disabled={exportingProfile}
          >
          <Text style={[styles.toggleText, styles.toggleTextActive]}>
            {exportingProfile ? '导出中…' : '导出档案'}
          </Text>
        </TouchableOpacity>
        </View>
      </View>
      <View style={styles.filterBar}>
        <View style={styles.toggleGroup}>
          {WECHAT_FEATURES_ENABLED && (
            <>
              <TouchableOpacity
                style={[styles.toggle, chatFilter === 'chatted' && styles.toggleChat]}
                onPress={() => setChatFilter(chatFilter === 'chatted' ? 'all' : 'chatted')}
              >
                <Text style={[styles.toggleText, chatFilter === 'chatted' && styles.toggleTextActive]}>
                  最近聊过
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggle, chatFilter === 'notChatted' && styles.toggleChat]}
                onPress={() => setChatFilter(chatFilter === 'notChatted' ? 'all' : 'notChatted')}
              >
                <Text style={[styles.toggleText, chatFilter === 'notChatted' && styles.toggleTextActive]}>
                  没聊过
                </Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity
            style={[styles.toggle, shanghaiOnly && styles.toggleActive]}
            onPress={() => setShanghaiOnly((v) => !v)}
          >
            <Text
              style={[
                styles.toggleText,
                shanghaiOnly && styles.toggleTextActive,
              ]}
            >
              {shanghaiOnly ? '仅上海' : '全部'}
            </Text>
          </TouchableOpacity>
          {WECHAT_FEATURES_ENABLED && (
            <TouchableOpacity
              style={[styles.toggle, wechatOnly && styles.toggleWechat]}
              onPress={() => setWechatOnly((v) => !v)}
            >
              <Text style={[styles.toggleText, wechatOnly && styles.toggleTextActive]}>
                有微信
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.toggle, smart && styles.toggleActive]}
            onPress={openSmart}
          >
            <Text style={[styles.toggleText, smart && styles.toggleTextActive]}>
              💬 智能查找
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.filterSummary} numberOfLines={1}>
        {WECHAT_FEATURES_ENABLED && chatFilter === 'chatted'
          ? '最近聊过 · '
          : WECHAT_FEATURES_ENABLED && chatFilter === 'notChatted'
            ? '没聊过 · '
            : ''}
        {shanghaiOnly ? '仅上海 · ' : ''}
        {WECHAT_FEATURES_ENABLED && wechatOnly ? '微信好友' : '手机号'}
      </Text>
    </View>
      {smart && (
        <View style={styles.smartBanner}>
          <Text style={styles.smartBannerText} numberOfLines={1}>
            💬 智能筛选：{smart.query}（{smart.ids.length}）
          </Text>
          <TouchableOpacity onPress={clearSmart} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.smartClear}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
      <TextInput
        style={styles.search}
        placeholder="搜索姓名 / 电话 / 邮箱"
        value={keyword}
        onChangeText={setKeyword}
        autoCapitalize="none"
        clearButtonMode="while-editing"
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          refreshing={loading}
          onRefresh={() => loadContacts({ force: true })}
          ListEmptyComponent={
            <Text style={styles.hint}>
              {contacts.length === 0
                ? '没有含手机号的联系人'
                : shanghaiOnly && regionFiltered.length === 0
                  ? '没有归属地为上海的手机号'
                  : '无匹配结果'}
            </Text>
          }
          renderItem={({ item }) => {
            const wx = WECHAT_FEATURES_ENABLED ? findWechat(item.name) : null;
            const draftReady = wx ? findFollowupDraft(wx.wxid) : null;
            return (
            <View style={styles.card}>
              <Text style={styles.name}>{item.name}</Text>
              {/* 操作按钮平铺：横向排布、可换行；self 版隐藏通用「AI 起草」，仅公开版显示 */}
              <View style={styles.actionRow}>
                {!WECHAT_FEATURES_ENABLED && (
                  <TouchableOpacity
                    style={styles.draftBtnInline}
                    onPress={() => openCompose(item)}
                  >
                    <Text style={styles.draftBtnInlineText}>✍️ AI 起草</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => openInsight(item)}
                  style={styles.draftBtnInline}
                >
                  <Text style={styles.draftBtnInlineText}>💡 AI 画像</Text>
                </TouchableOpacity>
                {draftReady && (
                  <TouchableOpacity
                    style={styles.draftBtnInline}
                    onPress={() => openDraft(item)}
                  >
                    <Text style={styles.draftBtnInlineText}>✍️ AI 草稿</Text>
                  </TouchableOpacity>
                )}
                <NoteBadge id={item.id} onPress={() => openNote(item)} />
              </View>
              {wx ? (
                <TouchableOpacity onPress={() => openWechat(wx)}>
                  <Text style={styles.wechat}>
                    💬 {wx.wxid}
                    {wx.name !== item.name ? `（微信备注：${wx.name}）` : ''}
                  </Text>
                  <Text style={styles.wechatHint}>点按复制并跳转微信</Text>
                </TouchableOpacity>
              ) : null}
              {item.phones.map((p, i) => {
                const meta = getPhoneMeta(p);
                const region =
                  meta && (meta.province || meta.city)
                    ? meta.province && meta.city && meta.province !== meta.city
                      ? `${meta.province}·${meta.city}`
                      : meta.province || meta.city
                    : '';
                const tag = [region, meta?.operator].filter(Boolean).join(' · ');
                return (
                  <TouchableOpacity
                    key={`${p}-${i}`}
                    onPress={() => Linking.openURL(`tel:${p}`)}
                  >
                    <Text style={styles.phone}>📞 {p}</Text>
                    {tag ? <Text style={styles.meta}>📍 {tag}</Text> : null}
                  </TouchableOpacity>
                );
              })}
              {item.emails.map((e, i) => (
                <Text key={`${e}-${i}`} style={styles.email}>
                  ✉️ {e}
                </Text>
              ))}
            </View>
            );
          }}
        />
      )}
      <Modal
        visible={!!draftFor}
        animationType="slide"
        onRequestClose={() => setDraftFor(null)}
      >
        <View style={styles.draftModal}>
          <View style={styles.draftHeader}>
            <Text style={styles.draftTitle}>AI 跟进草稿</Text>
            <TouchableOpacity onPress={() => setDraftFor(null)}>
              <Text style={styles.draftClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {draftFor ? (
            <ScrollView style={styles.draftBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.draftForName}>{draftFor.name}</Text>
              {draftWx ? (
                <Text style={styles.draftForWx}>
                  💬 {draftWx.wxid}
                  {draftWx.name !== draftFor.name
                    ? `（微信备注：${draftWx.name}）`
                    : ''}
                  {draftWx.fuzzy ? ' · 模糊匹配' : ''}
                </Text>
              ) : null}

              {/* 离线预生成草稿：基于历史聊天，无需联网即可复制 / 发送 */}
              {preDraft ? (
                <View style={styles.draftCard}>
                  <View style={styles.draftCardHead}>
                    <Text style={styles.draftCardTag}>
                      已预生成草稿（基于历史聊天）
                    </Text>
                    <TouchableOpacity
                      onPress={() =>
                        copyText(
                          buildDraftBundle(
                            draftFor.name,
                            draftWx,
                            preDraft.draft,
                          ),
                        )
                      }
                    >
                      <Text style={styles.draftCopy}>复制全部</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.draftText}>{preDraft.draft}</Text>
                  <Text style={styles.draftPrivacy}>
                    📦 离线草稿，无需联网。共 {preDraft.msgCount} 条历史消息（{preDraft.generatedAt}）。
                  </Text>
                  {draftWx ? (
                    <TouchableOpacity
                      style={styles.draftRawToggle}
                      onPress={() => openWechat(draftWx, preDraft.draft)}
                    >
                      <Text style={styles.draftCopy}>
                        跳微信发（已复制草稿）
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}

              {/* 在线生成控制区：本次目标 + 场景多选 + 生成按钮 */}
              <Text style={styles.genLabel}>本次目标 / 上下文（可选）</Text>
              <TextInput
                style={styles.goalInput}
                value={genGoal}
                onChangeText={setGenGoal}
                placeholder="如：刚合作完一个项目，想约个电话"
                placeholderTextColor="#9ca3af"
                multiline
              />
              <Text style={styles.genLabel}>生成场景（可多选）</Text>
              <View style={styles.genChips}>
                {GEN_KEYS.map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[
                      styles.genChip,
                      genScenarios.includes(s) && styles.genChipActive,
                    ]}
                    onPress={() => toggleScenario(s)}
                  >
                    <Text
                      style={[
                        styles.genChipText,
                        genScenarios.includes(s) && styles.genChipTextActive,
                      ]}
                    >
                      {s}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.draftPrivacy}>
                生成将调用模型（见「设置」），提示词仅含姓名/单位/归属地/本次目标，不含手机号。
                {preDraft ? '已用该联系人的历史聊天草稿做风格范例。' : ''}
              </Text>
              {draftLoading ? (
                <View style={styles.draftGenBtn}>
                  <ActivityIndicator color="#fff" />
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.draftGenBtn}
                  onPress={() => generateDraft(draftFor, genGoal, genScenarios)}
                >
                  <Text style={styles.draftGenText}>
                    ✨ 生成{genScenarios.length ? `（${genScenarios.length} 个场景）` : ''}
                  </Text>
                </TouchableOpacity>
              )}
              {draftLoading ? (
                <View style={styles.draftLoading}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.hint}>AI 生成中…</Text>
                </View>
              ) : null}
              {draftError ? (
                <Text style={styles.draftErr}>⚠️ {draftError}</Text>
              ) : null}
              {draftData ? (
                <View style={styles.draftScroll}>
                  {(() => {
                    const keys = GEN_KEYS;
                    const anyFilled = keys.some((t) => draftData[t]);
                    return (
                      <>
                        {anyFilled ? (
                          keys.map((t) =>
                            draftData[t] ? (
                              <View key={t} style={styles.draftCard}>
                                <View style={styles.draftCardHead}>
                                  <Text style={styles.draftCardTag}>{t}</Text>
                                  <TouchableOpacity
                                    onPress={() => copyText(draftData[t])}
                                  >
                                    <Text style={styles.draftCopy}>复制</Text>
                                  </TouchableOpacity>
                                </View>
                                <TextInput
                                  style={styles.draftEditText}
                                  value={draftData[t]}
                                  onChangeText={(v) =>
                                    setDraftData((prev) => {
                                      if (!prev) return prev;
                                      const next = { ...prev } as Record<string, string>;
                                      next[t] = v;
                                      return next as typeof prev;
                                    })
                                  }
                                  multiline
                                />
                              </View>
                            ) : null,
                          )
                        ) : draftRaw ? (
                          <View style={styles.draftCard}>
                            <Text style={styles.draftCardTag}>原始回复</Text>
                            <Text style={styles.draftText}>{draftRaw}</Text>
                            <Text style={styles.draftPrivacy}>
                              模型已返回内容，但未匹配到场景格式，已展示原文。
                            </Text>
                          </View>
                        ) : null}
                        {draftRaw ? (
                          <TouchableOpacity
                            style={styles.draftRawToggle}
                            onPress={() => setShowRaw((v) => !v)}
                          >
                            <Text style={styles.draftCopy}>
                              {showRaw ? '隐藏原始回复' : '查看原始回复'}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                        {showRaw && draftRaw ? (
                          <View style={styles.draftCard}>
                            <Text style={styles.draftText}>{draftRaw}</Text>
                          </View>
                        ) : null}
                        <View style={styles.draftActions}>
                          <TouchableOpacity
                            style={styles.draftActionBtn}
                            onPress={() => copyAll(draftData)}
                          >
                            <Text style={styles.draftActionText}>复制全部</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.draftActionBtn}
                            onPress={() => generateDraft(draftFor, genGoal, genScenarios)}
                          >
                            <Text style={styles.draftActionText}>重新生成</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.draftActionBtn, styles.draftSaveBtn]}
                            onPress={saveGenerated}
                          >
                            <Text style={[styles.draftActionText, styles.draftSaveText]}>
                              保存
                            </Text>
                          </TouchableOpacity>
                          {draftWx ? (
                            <TouchableOpacity
                              style={[
                                styles.draftActionBtn,
                                styles.draftActionWx,
                              ]}
                              onPress={() => openWechat(draftWx)}
                            >
                              <Text
                                style={[
                                  styles.draftActionText,
                                  styles.draftActionWxText,
                                ]}
                              >
                                跳微信发
                              </Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                        {genSavedAt ? (
                          <Text style={styles.genSavedText}>
                            ✓ 已保存于 {new Date(genSavedAt).toLocaleString('zh-CN')}
                          </Text>
                        ) : null}
                      </>
                    );
                  })()}
                </View>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      </Modal>

      {/* 通用 AI 消息起草（与微信解耦，public / self 均可使用） */}
      <Modal
        visible={!!composeFor}
        animationType="slide"
        onRequestClose={() => setComposeFor(null)}
      >
        <View style={styles.draftModal}>
          <View style={styles.draftHeader}>
            <Text style={styles.draftTitle}>AI 消息起草</Text>
            <TouchableOpacity onPress={() => setComposeFor(null)}>
              <Text style={styles.draftClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {composeFor ? (
            <ScrollView style={styles.draftBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.draftForName}>{composeFor.name}</Text>
              <Text style={styles.filterSummary}>
                基于联系人姓名与归属地起草，不含手机号 / 微信；可填「关系 / 称呼」以正确尊称（如对方比你小别叫哥）。内容由你的模型生成，发送前请自行核对。
              </Text>

              <Text style={styles.genLabel}>本次目标 / 上下文（可选）</Text>
              <TextInput
                style={styles.goalInput}
                value={composeGoal}
                onChangeText={setComposeGoal}
                placeholder="如：刚合作完一个项目，想约个电话"
                placeholderTextColor="#9ca3af"
                multiline
              />
              <Text style={styles.genLabel}>对方关系 / 称呼（可选）</Text>
              <TextInput
                style={styles.goalInput}
                value={composeRelation}
                onChangeText={setComposeRelation}
                placeholder="如：李总 / 学妹 / 老同学"
                placeholderTextColor="#9ca3af"
              />
              <Text style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                留空则按名字自然称呼（姓可舍去）；若对方比你年轻，请勿填“哥/姐”等长辈称呼
              </Text>
              <Text style={styles.genLabel}>生成场景（可多选）</Text>
              <View style={styles.genChips}>
                {COMPOSE_KEYS.map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[
                      styles.genChip,
                      composeScenarios.includes(s) && styles.genChipActive,
                    ]}
                    onPress={() => toggleComposeScenario(s)}
                  >
                    <Text
                      style={[
                        styles.genChipText,
                        composeScenarios.includes(s) && styles.genChipTextActive,
                      ]}
                    >
                      {s}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {composeLoading ? (
                <View style={styles.draftGenBtn}>
                  <ActivityIndicator color="#fff" />
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.draftGenBtn}
                  onPress={() => generateCompose(composeFor)}
                >
                  <Text style={styles.draftGenText}>
                    ✨ 生成{composeScenarios.length ? `（${composeScenarios.length} 个场景）` : ''}
                  </Text>
                </TouchableOpacity>
              )}
              {composeLoading ? (
                <View style={styles.draftLoading}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.hint}>AI 生成中…</Text>
                </View>
              ) : null}
              {composeError ? (
                <Text style={styles.draftErr}>⚠️ {composeError}</Text>
              ) : null}
              {composeData ? (
                <View style={styles.draftScroll}>
                  {(() => {
                    const anyFilled = composeScenarios.some((t) => composeData[t]);
                    return (
                      <>
                        {anyFilled ? (
                          composeScenarios.map((t) =>
                            composeData[t] ? (
                              <View key={t} style={styles.draftCard}>
                                <View style={styles.draftCardHead}>
                                  <Text style={styles.draftCardTag}>{t}</Text>
                                  <TouchableOpacity
                                    onPress={() => copyText(composeData[t])}
                                  >
                                    <Text style={styles.draftCopy}>复制</Text>
                                  </TouchableOpacity>
                                </View>
                                <TextInput
                                  style={styles.draftEditText}
                                  value={composeData[t]}
                                  onChangeText={(v) =>
                                    setComposeData((prev) => {
                                      if (!prev) return prev;
                                      const next = { ...prev };
                                      next[t] = v;
                                      return next;
                                    })
                                  }
                                  multiline
                                />
                              </View>
                            ) : null,
                          )
                        ) : composeRaw ? (
                          <View style={styles.draftCard}>
                            <Text style={styles.draftCardTag}>原始回复</Text>
                            <Text style={styles.draftText}>{composeRaw}</Text>
                            <Text style={styles.draftPrivacy}>
                              模型已返回内容，但未匹配到场景格式，已展示原文。
                            </Text>
                          </View>
                        ) : null}
                        <View style={styles.draftActions}>
                          <TouchableOpacity
                            style={styles.draftActionBtn}
                            onPress={copyComposeAll}
                          >
                            <Text style={styles.draftActionText}>复制全部</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.draftActionBtn}
                            onPress={() => generateCompose(composeFor)}
                          >
                            <Text style={styles.draftActionText}>重新生成</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.draftActionBtn, styles.draftSaveBtn]}
                            onPress={saveCompose}
                          >
                            <Text style={[styles.draftActionText, styles.draftSaveText]}>
                              保存
                            </Text>
                          </TouchableOpacity>
                        </View>
                        {composeSavedAt ? (
                          <Text style={styles.genSavedText}>
                            ✓ 已保存于 {new Date(composeSavedAt).toLocaleString('zh-CN')}
                          </Text>
                        ) : null}
                        <TouchableOpacity
                          style={styles.draftRawToggle}
                          onPress={async () => {
                            await clearComposedDrafts();
                            setComposeData(null);
                            setComposeRaw('');
                            setComposeSavedAt(null);
                            Alert.alert('已清除', '本机保存的通用草稿已删除');
                          }}
                        >
                          <Text style={styles.draftCopy}>🗑 清除本机草稿</Text>
                        </TouchableOpacity>
                      </>
                    );
                  })()}
                </View>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      </Modal>

      <Modal
        visible={!!insightFor}
        animationType="slide"
        onRequestClose={() => setInsightFor(null)}
      >
        <View style={styles.draftModal}>
          <View style={styles.draftHeader}>
            <Text style={styles.draftTitle}>AI 联系人画像</Text>
            <TouchableOpacity onPress={() => setInsightFor(null)}>
              <Text style={styles.draftClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {insightFor ? (
            <ScrollView style={styles.draftBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.draftForName}>{insightFor.name}</Text>
              <Text style={styles.filterSummary}>
                基于联系人姓名与归属地分析，不含手机号 / 微信；可填「关系 / 称呼」以获得更贴切的建议（如对方比你小别叫哥）。内容由你的模型生成，仅供参考。
              </Text>

              <Text style={styles.genLabel}>关系 / 称呼（可选）</Text>
              <TextInput
                style={styles.goalInput}
                value={insightRelation}
                onChangeText={setInsightRelation}
                placeholder="如：李总 / 学妹 / 老同学"
                placeholderTextColor="#9ca3af"
              />
              <Text style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                留空则按名字自然称呼（姓可舍去）；若对方比你年轻，请勿填“哥/姐”等长辈称呼
              </Text>

              {!insightData ? (
                <TouchableOpacity
                  style={styles.draftGenBtn}
                  onPress={() => generateInsight(insightFor)}
                >
                  <Text style={styles.draftGenText}>✨ 生成画像</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.draftGenBtn}
                  onPress={() => generateInsight(insightFor)}
                >
                  <Text style={styles.draftGenText}>✨ 重新生成</Text>
                </TouchableOpacity>
              )}
              {insightLoading ? (
                <View style={styles.draftLoading}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.hint}>AI 生成中…</Text>
                </View>
              ) : null}
              {insightError ? (
                <Text style={styles.draftErr}>⚠️ {insightError}</Text>
              ) : null}
              {insightData ? (
                <View style={styles.draftScroll}>
                  {(() => {
                    const blocks: { tag: string; text: string }[] = [
                      { tag: '关系定位', text: insightData.persona },
                      { tag: '沟通分寸', text: insightData.advice },
                      { tag: '破冰示例', text: insightData.icebreaker },
                    ];
                    return (
                      <>
                        {blocks.map((b) => (
                          <View key={b.tag} style={styles.draftCard}>
                            <View style={styles.draftCardHead}>
                              <Text style={styles.draftCardTag}>{b.tag}</Text>
                              {b.text ? (
                                <TouchableOpacity onPress={() => copyText(b.text)}>
                                  <Text style={styles.draftCopy}>复制</Text>
                                </TouchableOpacity>
                              ) : null}
                            </View>
                            <Text style={styles.draftText}>
                              {b.text || '（模型未返回该段内容）'}
                            </Text>
                          </View>
                        ))}
                        <View style={styles.draftActions}>
                          <TouchableOpacity
                            style={styles.draftActionBtn}
                            onPress={() =>
                              copyText(
                                [
                                  insightData.persona && `【关系定位】${insightData.persona}`,
                                  insightData.advice && `【沟通分寸】${insightData.advice}`,
                                  insightData.icebreaker && `【破冰示例】${insightData.icebreaker}`,
                                ]
                                  .filter(Boolean)
                                  .join('\n'),
                              )
                            }
                          >
                            <Text style={styles.draftActionText}>复制全部</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.draftActionBtn}
                            onPress={() => generateInsight(insightFor)}
                          >
                            <Text style={styles.draftActionText}>重新生成</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.draftActionBtn, styles.draftSaveBtn]}
                            onPress={saveInsightRec}
                          >
                            <Text style={[styles.draftActionText, styles.draftSaveText]}>
                              保存
                            </Text>
                          </TouchableOpacity>
                        </View>
                        {insightSavedAt ? (
                          <Text style={styles.genSavedText}>
                            ✓ 已保存于 {new Date(insightSavedAt).toLocaleString('zh-CN')}
                          </Text>
                        ) : null}
                        <TouchableOpacity
                          style={styles.draftRawToggle}
                          onPress={async () => {
                            await clearInsights();
                            setInsightData(null);
                            setInsightRaw('');
                            setInsightSavedAt(null);
                            Alert.alert('已清除', '本机保存的 AI 画像已删除');
                          }}
                        >
                          <Text style={styles.draftCopy}>🗑 清除本机画像</Text>
                        </TouchableOpacity>
                      </>
                    );
                  })()}
                </View>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      </Modal>

      <Modal
        visible={!!noteFor}
        animationType="slide"
        onRequestClose={() => setNoteFor(null)}
      >
        <View style={styles.draftModal}>
          <View style={styles.draftHeader}>
            <Text style={styles.draftTitle}>联系人备注</Text>
            <TouchableOpacity onPress={() => setNoteFor(null)}>
              <Text style={styles.draftClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {noteFor ? (
            <ScrollView style={styles.draftBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.draftForName}>{noteFor.name}</Text>
              <Text style={styles.filterSummary}>
                仅存本机，不读微信、也不会自动外发；你写下的内容会在生成 AI 起草 / 画像时作为上下文，让输出更贴切。
              </Text>
              <Text style={styles.genLabel}>备注（可选）</Text>
              <TextInput
                style={[styles.goalInput, { minHeight: 90 }]}
                value={noteText}
                onChangeText={setNoteText}
                placeholder="如：上次聊到 X 项目 / 他是做后端的 / 喜欢爬山"
                placeholderTextColor="#9ca3af"
                multiline
              />
              <TouchableOpacity style={styles.draftGenBtn} onPress={saveNoteRec}>
                <Text style={styles.draftGenText}>💾 保存备注</Text>
              </TouchableOpacity>
              {noteSavedAt ? (
                <Text style={styles.genSavedText}>
                  ✓ 已保存于 {new Date(noteSavedAt).toLocaleString('zh-CN')}
                </Text>
              ) : null}
              <TouchableOpacity style={styles.draftRawToggle} onPress={clearNoteRec}>
                <Text style={styles.draftCopy}>🗑 清除备注</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : null}
        </View>
      </Modal>

      {/* 自然语言查找弹层 */}
      <Modal visible={smartModal} animationType="slide">
        <View style={styles.draftModal}>
          <View style={styles.draftHeader}>
            <Text style={styles.draftTitle}>💬 智能查找</Text>
            <TouchableOpacity onPress={() => setSmartModal(false)}>
              <Text style={styles.draftClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.draftBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.draftPrivacy}>
              用一句话描述要找的人，例如「上海的、做技术的朋友」「最近想约饭的朋友」「苏州的同事」。
              会结合姓名、手机号归属地、你的本地备注来匹配；只把这些信息发给你自己配置的 LLM，不含手机号原文。
            </Text>
            <Text style={styles.genLabel}>查找描述</Text>
            <TextInput
              style={styles.goalInput}
              value={smartQuery}
              onChangeText={setSmartQuery}
              placeholder="如：上海的、做技术的朋友"
              placeholderTextColor="#9ca3af"
              multiline
            />
            <TouchableOpacity style={styles.draftGenBtn} onPress={runSmart} disabled={smartLoading}>
              <Text style={styles.draftGenText}>{smartLoading ? '查找中…' : '🔍 查找'}</Text>
            </TouchableOpacity>
            {smartError ? <Text style={styles.draftErr}>{smartError}</Text> : null}
            {smartResult ? (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.genLabel}>匹配到 {smartResult.length} 人：</Text>
                {smartResult.length === 0 ? (
                  <Text style={styles.hint}>没有匹配的联系人，换个说法试试</Text>
                ) : (
                  smartResult.map((r) => (
                    <View key={r.id} style={styles.draftCard}>
                      <Text style={styles.draftText}>{r.name}</Text>
                    </View>
                  ))
                )}
                {smartResult.length > 0 && (
                  <TouchableOpacity
                    style={[styles.draftGenBtn, styles.draftSaveBtn]}
                    onPress={applySmart}
                  >
                    <Text style={styles.draftGenText}>✓ 应用筛选（{smartResult.length}）</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : null}
            <View style={{ height: 24 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f7f7f7',
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    flexShrink: 0,
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexShrink: 0,
    gap: 6,
  },
  titleCount: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
    flexShrink: 0,
  },
  exportGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  header: {
    marginBottom: 4,
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  toggleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterSummary: {
    fontSize: 12,
    color: '#888',
    marginBottom: 4,
  },
  segGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  segItem: {
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#e5e7eb',
    marginRight: 4,
  },
  toggle: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: '#e5e7eb',
  },
  exportBtn: {
    backgroundColor: '#16a34a',
  },
  toggleActive: {
    backgroundColor: '#0a7ea4',
  },
  toggleChat: {
    backgroundColor: '#7c3aed',
  },
  toggleWechat: {
    backgroundColor: '#07c160',
  },
  wechat: {
    fontSize: 12,
    color: '#6b7280',
    paddingVertical: 1,
  },
  wechatHint: {
    fontSize: 11,
    color: '#9ca3af',
    marginBottom: 2,
  },
  toggleText: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '600',
  },
  toggleTextActive: {
    color: '#fff',
  },
  search: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
  },
  smartBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#eef2ff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c7d2fe',
  },
  smartBannerText: {
    flex: 1,
    fontSize: 13,
    color: '#3730a3',
    fontWeight: '600',
    marginRight: 8,
  },
  smartClear: {
    fontSize: 16,
    color: '#6d28d9',
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e5e5',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
    marginBottom: 4,
  },
  draftBtnInline: {
    backgroundColor: '#fff7ed',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#fdba74',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  draftBtnInlineText: {
    fontSize: 12,
    color: '#ea580c',
    fontWeight: '600',
  },
  draftReady: {
    fontSize: 12,
    color: '#16a34a',
    fontWeight: '600',
    marginTop: 2,
  },
  phone: {
    fontSize: 14,
    color: '#0a7ea4',
    paddingVertical: 2,
  },
  meta: {
    fontSize: 12,
    color: '#999',
    paddingVertical: 1,
    paddingLeft: 2,
  },
  email: {
    fontSize: 13,
    color: '#666',
    paddingVertical: 2,
  },
  hint: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#0a7ea4',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  buttonSecondary: {
    backgroundColor: '#6b7280',
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  // AI 草稿弹层
  draftModal: {
    flex: 1,
    backgroundColor: '#f7f7f7',
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  draftHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  draftTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  draftClose: {
    fontSize: 22,
    color: '#666',
    paddingHorizontal: 8,
  },
  draftBody: {
    flex: 1,
  },
  draftForName: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 4,
  },
  draftForWx: {
    fontSize: 13,
    color: '#07c160',
    marginBottom: 8,
  },
  draftPrivacy: {
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 12,
    lineHeight: 16,
  },
  draftGenBtn: {
    backgroundColor: '#ea580c',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  draftGenText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  draftLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
  },
  draftErr: {
    fontSize: 13,
    color: '#dc2626',
    marginVertical: 8,
    lineHeight: 18,
  },
  draftScroll: {
    marginTop: 8,
  },
  draftRawToggle: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
  },
  draftCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e5e5',
  },
  draftCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  draftCardTag: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ea580c',
  },
  draftCopy: {
    fontSize: 13,
    color: '#0a7ea4',
    fontWeight: '600',
  },
  draftText: {
    fontSize: 15,
    color: '#222',
    lineHeight: 22,
  },
  draftActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    marginBottom: 20,
  },
  draftActionBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d1d5db',
  },
  draftActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  draftActionWx: {
    backgroundColor: '#07c160',
    borderColor: '#07c160',
  },
  draftActionWxText: {
    color: '#fff',
  },
  genLabel: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
  },
  goalInput: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    minHeight: 44,
    textAlignVertical: 'top',
  },
  genChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  genChip: {
    backgroundColor: '#eef2f5',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  genChipActive: {
    backgroundColor: '#ea580c',
  },
  genChipText: {
    fontSize: 13,
    color: '#374151',
  },
  genChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  draftEditText: {
    fontSize: 15,
    color: '#222',
    lineHeight: 22,
    marginTop: 4,
    backgroundColor: '#fafafa',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    paddingHorizontal: 10,
    padding: 8,
    minHeight: 48,
    textAlignVertical: 'top',
  },
  draftSaveBtn: {
    backgroundColor: '#0a7ea4',
    borderColor: '#0a7ea4',
  },
  draftSaveText: {
    color: '#fff',
  },
  genSavedText: {
    fontSize: 12,
    color: '#16a34a',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
});
