import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { PROVIDERS } from '../config/providers';
import {
  LlmConfig,
  deleteConfig,
  getApiKey,
  loadActiveId,
  loadConfigs,
  newConfigId,
  setActiveId,
  upsertConfig,
} from '../utils/llmSettings';
import { testConnection, TestResult } from '../utils/llmClient';
import {
  clearContactsCache,
  requestContactsRefresh,
} from '../utils/contactsCache';
import {
  isWechatDraftsEnabledSync,
  isWechatDraftsFeatureEnabled,
  setWechatDraftsEnabled,
} from '../utils/followupDrafts';
import { clearGeneratedDrafts } from '../utils/generatedDrafts';
import { clearComposedDrafts } from '../utils/contactComposer';
import { loadProfile, saveProfile, type Gender } from '../utils/userProfile';

export default function SettingsScreen() {
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [activeId, setActive] = useState<string | null>(null);

  // 编辑表单状态
  const [editingId, setEditingId] = useState<string | null>(null); // null = 新增
  const [providerId, setProviderId] = useState('deepseek');
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState(''); // 空 = 编辑时保留原 Key
  const [keyStored, setKeyStored] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const provider = useMemo(
    () => PROVIDERS.find((p) => p.id === providerId),
    [providerId],
  );

  const refresh = useCallback(async () => {
    const [list, act] = await Promise.all([loadConfigs(), loadActiveId()]);
    setConfigs(list);
    setActive(act ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openNew = useCallback(() => {
    const p = PROVIDERS.find((x) => x.id === 'deepseek') ?? PROVIDERS[0];
    setEditingId(null);
    setProviderId(p.id);
    setBaseURL(p.baseURL);
    setModel(p.defaultModel);
    setApiKey('');
    setKeyStored(false);
    setTestResult(null);
    setShowForm(true);
  }, []);

  const openEdit = useCallback(async (cfg: LlmConfig) => {
    setEditingId(cfg.id);
    setProviderId(cfg.providerId);
    setBaseURL(cfg.baseURL);
    setModel(cfg.model);
    setApiKey('');
    setKeyStored(cfg.hasKey);
    setTestResult(null);
    setShowForm(true);
  }, []);

  const pickProvider = useCallback((id: string) => {
    setProviderId(id);
    const p = PROVIDERS.find((x) => x.id === id);
    if (p) {
      setBaseURL(p.baseURL);
      setModel(p.defaultModel);
    }
    setTestResult(null);
  }, []);

  const handleTest = useCallback(async () => {
    const key = apiKey || (editingId ? (await getApiKey(editingId)) ?? '' : '');
    if (!baseURL || !model) {
      Alert.alert('信息不全', '请先填写 Base URL 和 Model');
      return;
    }
    if (!key) {
      Alert.alert('缺少 API Key', '请输入 API Key 后再测试');
      return;
    }
    setTesting(true);
    setTestResult(null);
    const r = await testConnection({ baseURL, model, apiKey: key });
    setTestResult(r);
    setTesting(false);
  }, [apiKey, baseURL, model, editingId]);

  const handleSave = useCallback(async () => {
    if (!baseURL.trim() || !model.trim()) {
      Alert.alert('信息不全', '请填写 Base URL 和 Model');
      return;
    }
    if (!editingId && !apiKey.trim()) {
      Alert.alert('缺少 API Key', '新配置需要输入 API Key');
      return;
    }
    const id = editingId ?? newConfigId();
    const label = provider?.label ?? '自定义';
    const list = await upsertConfig(
      {
        id,
        providerId,
        label,
        baseURL: baseURL.trim(),
        model: model.trim(),
      },
      apiKey.trim() ? apiKey.trim() : undefined, // 空 = 保留原 Key
    );
    setConfigs(list);
    setShowForm(false);
    setApiKey('');
    await refresh();
  }, [editingId, providerId, provider, baseURL, model, apiKey, refresh]);

  const handleDelete = useCallback(
    (cfg: LlmConfig) => {
      Alert.alert('删除配置', `确定删除「${cfg.label} · ${cfg.model}」？其 API Key 也会一并从安全存储中清除。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            await deleteConfig(cfg.id);
            await refresh();
          },
        },
      ]);
    },
    [refresh],
  );

  const handleActivate = useCallback(
    async (id: string) => {
      await setActiveId(id);
      setActive(id);
    },
    [],
  );

  // 通讯录缓存：清除 / 重新获取最新
  const handleClearCache = useCallback(() => {
    Alert.alert('清除通讯录缓存', '将丢弃已缓存的通讯录数据，并从设备重新读取。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清除',
        style: 'destructive',
        onPress: async () => {
          await clearContactsCache();
          Alert.alert('已清除', '已触发从设备重新读取，切回「通讯录」即可看到最新数据');
        },
      },
    ]);
  }, []);

  const handleRefreshLatest = useCallback(() => {
    Alert.alert('重新获取最新', '将忽略缓存，直接从设备通讯录重新读取（联系人较多时可能较慢）。', [
      { text: '取消', style: 'cancel' },
      {
        text: '获取',
        onPress: () => {
          requestContactsRefresh();
          Alert.alert('已开始', '正在从设备重新读取通讯录，切回「通讯录」即可看到最新数据');
        },
      },
    ]);
  }, []);

  // 微信聊天记录衍生数据：编译期总开关(.env) + 运行期开关 + 清除已生成草稿
  const featureOn = isWechatDraftsFeatureEnabled(); // 编译期常量，.env 控制
  const [wechatDraftsOn, setWechatDraftsOn] = useState(true);
  useEffect(() => {
    setWechatDraftsOn(isWechatDraftsEnabledSync());
  }, []);

  // 「关于我」：用户自己的性别 / 希望被称呼，供 AI 画像与起草作为「我方信息」上下文
  const [gender, setGender] = useState<Gender>('unspecified');
  const [selfName, setSelfName] = useState('');
  useEffect(() => {
    loadProfile().then((p) => {
      setGender(p.gender);
      setSelfName(p.selfName ?? '');
    });
  }, []);
  const changeGender = useCallback((g: Gender) => {
    setGender(g);
    saveProfile({ gender: g, selfName: selfName.trim() });
  }, [selfName]);
  const changeSelfName = useCallback((t: string) => {
    setSelfName(t);
    saveProfile({ gender, selfName: t.trim() });
  }, [gender]);

  const toggleWechatDrafts = useCallback(
    (next: boolean) => {
      Alert.alert(
        next ? '启用微信聊天记录衍生数据' : '停用微信聊天记录衍生数据',
        next
          ? '将恢复基于聊天记录的「最近聊过」分类与生成时的风格范例。'
          : '停用后 App 不再读取/展示/发送这些聊天衍生草稿，「最近聊过」分类与生成风格范例将停止生效（等同干净克隆）。数据随包发布、无法物理删除，停用即不触碰。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: next ? '启用' : '停用',
            style: next ? 'default' : 'destructive',
            onPress: async () => {
              await setWechatDraftsEnabled(next);
              setWechatDraftsOn(next);
            },
          },
        ],
      );
    },
    [],
  );

  const handleClearGenerated = useCallback(() => {
    Alert.alert('清除已生成草稿', '将删除本机保存的所有 AI 生成草稿（按联系人分散存储，含通用起草与微信跟进），不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清除',
        style: 'destructive',
        onPress: async () => {
          await clearGeneratedDrafts();
          await clearComposedDrafts();
          Alert.alert('已清除', '所有已生成的草稿已从本机移除');
        },
      },
    ]);
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>LLM 设置</Text>
        <Text style={styles.subtitle}>
          API Key 存系统安全存储（Keychain/Keystore），不与配置同处、不进代码仓库
        </Text>

        {/* 已保存配置列表 */}
        {configs.length === 0 && !showForm ? (
          <Text style={styles.hint}>还没有模型配置，点下方「添加配置」开始</Text>
        ) : null}
        {configs.map((c) => (
          <TouchableOpacity
            key={c.id}
            style={[styles.card, c.id === activeId && styles.cardActive]}
            onPress={() => handleActivate(c.id)}
            onLongPress={() => handleDelete(c)}
          >
            <View style={styles.flex}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{c.label}</Text>
                {c.id === activeId ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>主配置</Text>
                  </View>
                ) : null}
                {!c.hasKey ? (
                  <View style={[styles.badge, styles.badgeWarn]}>
                    <Text style={styles.badgeText}>缺 Key</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.cardLine}>{c.model}</Text>
              <Text style={styles.cardLineDim} numberOfLines={1}>
                {c.baseURL}
              </Text>
            </View>
            <TouchableOpacity style={styles.editBtn} onPress={() => openEdit(c)}>
              <Text style={styles.editBtnText}>编辑</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
        {configs.length > 0 ? (
          <Text style={styles.hintSmall}>点卡片设为主配置 · 长按删除</Text>
        ) : null}

        {!showForm ? (
          <TouchableOpacity style={styles.primaryBtn} onPress={openNew}>
            <Text style={styles.primaryBtnText}>＋ 添加配置</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.form}>
            <Text style={styles.formTitle}>
              {editingId ? '编辑配置' : '新增配置'}
            </Text>

            <Text style={styles.label}>服务商</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
              {PROVIDERS.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.chip, providerId === p.id && styles.chipActive]}
                  onPress={() => pickProvider(p.id)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      providerId === p.id && styles.chipTextActive,
                    ]}
                  >
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.label}>Base URL</Text>
            <TextInput
              style={styles.input} placeholderTextColor="#9ca3af"
              value={baseURL}
              onChangeText={setBaseURL}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://api.example.com/v1"
            />

            <Text style={styles.label}>Model</Text>
            {provider ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
                {provider.models.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.chip, model === m && styles.chipActive]}
                    onPress={() => setModel(m)}
                  >
                    <Text style={[styles.chipText, model === m && styles.chipTextActive]}>
                      {m}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : null}
            <TextInput
              style={styles.input} placeholderTextColor="#9ca3af"
              value={model}
              onChangeText={setModel}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="自定义 Model ID"
            />

            <Text style={styles.label}>
              API Key{keyStored ? '（已保存，留空则不修改）' : ''}
            </Text>
            <TextInput
              style={styles.input} placeholderTextColor="#9ca3af"
              value={apiKey}
              onChangeText={setApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder={keyStored ? '••••••••（留空保留原 Key）' : 'sk-...'}
            />

            {testResult ? (
              <Text style={[styles.testResult, testResult.ok ? styles.testOk : styles.testFail]}>
                {testResult.ok
                  ? `✓ 连通（${testResult.latencyMs}ms）：${testResult.detail}`
                  : `✗ 失败（${testResult.latencyMs}ms）：${testResult.detail}`}
              </Text>
            ) : null}

            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.secondaryBtn, testing && styles.btnDisabled]}
                onPress={handleTest}
                disabled={testing}
              >
                {testing ? (
                  <ActivityIndicator size="small" color="#0a7ea4" />
                ) : (
                  <Text style={styles.secondaryBtnText}>测试连通</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryBtnSmall} onPress={handleSave}>
                <Text style={styles.primaryBtnText}>保存</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => {
                  setShowForm(false);
                  setApiKey('');
                  setTestResult(null);
                }}
              >
                <Text style={styles.cancelBtnText}>取消</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* 关于我：AI 画像 / 起草的「我方信息」上下文（仅本机、非隐私） */}
        <Text style={styles.sectionTitle}>关于我</Text>
        <Text style={styles.sectionHint}>
          AI 画像与消息起草会用这些信息作为「我方」背景（如沟通分寸会考虑你的性别）。
          仅存本机、只发往你自己配置的 LLM，不含任何第三方隐私。
        </Text>
        <View style={styles.segRow}>
          {(['male', 'female', 'unspecified'] as Gender[]).map((g) => {
            const label = g === 'male' ? '男' : g === 'female' ? '女' : '不愿透露';
            const active = gender === g;
            return (
              <TouchableOpacity
                key={g}
                style={[styles.segBtn, active && styles.segBtnActive]}
                onPress={() => changeGender(g)}
                activeOpacity={0.8}
              >
                <Text style={[styles.segText, active && styles.segTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TextInput
          style={styles.meInput}
          value={selfName}
          onChangeText={changeSelfName}
          placeholder="希望对方怎么称呼我（可选，如：老王 / 阿强）"
          placeholderTextColor="#9ca3af"
        />

        {/* 通讯录缓存管理 */}
        <Text style={styles.sectionTitle}>通讯录缓存</Text>
        <Text style={styles.sectionHint}>
          通讯录已从设备读取一次并缓存到本地，后续打开秒开。若设备通讯录有变动，可手动重新获取。
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={handleRefreshLatest}>
          <Text style={styles.primaryBtnText}>🔄 重新获取最新</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.primaryBtn, styles.clearBtn]} onPress={handleClearCache}>
          <Text style={styles.primaryBtnText}>🗑 清除缓存</Text>
        </TouchableOpacity>

        {/* 微信聊天记录衍生数据（隐私） —— 对外发布包（featureOn=false）整体不渲染，
            与 ContactsScreen 收起微信 UI、数据 bundle 物理排除互为一致 */}
        {featureOn && (
          <>
            <Text style={styles.sectionTitle}>微信聊天记录衍生数据</Text>
            <Text style={styles.sectionHint}>
              这些是「基于你的微信聊天记录」预生成的跟进草稿，随包发布、含私人语境。停用后 App
              不再读取/展示/发送它们，「最近聊过」分类与生成风格范例也会停止生效（等同干净克隆）。
            </Text>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleRowText}>启用微信聊天记录衍生数据</Text>
              <TouchableOpacity
                style={[styles.switch, wechatDraftsOn && styles.switchOn]}
                onPress={() => toggleWechatDrafts(!wechatDraftsOn)}
                activeOpacity={0.8}
              >
                <View style={[styles.knob, wechatDraftsOn && styles.knobOn]} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.primaryBtn, styles.clearBtn]}
              onPress={handleClearGenerated}
            >
              <Text style={styles.primaryBtnText}>🗑 清除已生成草稿</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={styles.footerPad} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f7f8fa', paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '700', marginTop: 60, marginBottom: 4 },
  subtitle: { fontSize: 12, color: '#8a8f98', marginBottom: 16 },
  hint: { fontSize: 14, color: '#8a8f98', marginVertical: 24, textAlign: 'center' },
  hintSmall: { fontSize: 11, color: '#a2a7b0', marginBottom: 8, textAlign: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  cardActive: { borderColor: '#0a7ea4' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  cardTitle: { fontSize: 15, fontWeight: '600', marginRight: 8 },
  badge: {
    backgroundColor: '#0a7ea4',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 6,
  },
  badgeWarn: { backgroundColor: '#e5a50a' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  cardLine: { fontSize: 13, color: '#374151' },
  cardLineDim: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  editBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#eef2f5',
    marginLeft: 8,
  },
  editBtnText: { color: '#0a7ea4', fontSize: 13, fontWeight: '600' },
  primaryBtn: {
    backgroundColor: '#0a7ea4',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnSmall: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginLeft: 10,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  form: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
  },
  formTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  label: { fontSize: 12, color: '#6b7280', marginTop: 10, marginBottom: 4 },
  chips: { flexGrow: 0, marginBottom: 6 },
  chip: {
    backgroundColor: '#eef2f5',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  chipActive: { backgroundColor: '#0a7ea4' },
  chipText: { fontSize: 12, color: '#374151' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#fafafa',
  },
  testResult: { fontSize: 12, marginTop: 10, lineHeight: 18 },
  testOk: { color: '#0f9d58' },
  testFail: { color: '#d93025' },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    minWidth: 92,
  },
  secondaryBtnText: { color: '#0a7ea4', fontSize: 14, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  cancelBtn: { marginLeft: 'auto', padding: 10 },
  cancelBtnText: { color: '#8a8f98', fontSize: 14 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 28, marginBottom: 4 },
  sectionHint: { fontSize: 12, color: '#8a8f98', marginBottom: 12, lineHeight: 17 },
  clearBtn: { backgroundColor: '#dc2626', marginTop: 10 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  toggleRowText: { fontSize: 14, fontWeight: '500', color: '#374151', flexShrink: 1, marginRight: 12 },
  switch: {
    width: 50,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#cbd5e1',
    padding: 3,
    justifyContent: 'center',
  },
  switchOn: { backgroundColor: '#0a7ea4' },
  knob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignSelf: 'flex-start',
  },
  knobOn: { alignSelf: 'flex-end' },
  footerPad: { height: 60 },
  segRow: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 4,
    marginTop: 8,
    marginBottom: 12,
  },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 9,
  },
  segBtnActive: { backgroundColor: '#0a7ea4' },
  segText: { fontSize: 14, fontWeight: '600', color: '#374151' },
  segTextActive: { color: '#fff' },
  meInput: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: '#111',
    marginBottom: 6,
  },
});
