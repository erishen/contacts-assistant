import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import ContactsScreen from './src/screens/ContactsScreen';
import ChatScreen from './src/screens/ChatScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { loadWechatDraftsEnabled } from './src/utils/followupDrafts';

type Tab = 'contacts' | 'chat' | 'settings';

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'contacts', icon: '👥', label: '通讯录' },
  { key: 'chat', icon: '💬', label: '聊天' },
  { key: 'settings', icon: '⚙️', label: '设置' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('contacts');

  // 启动时载入「微信聊天记录衍生数据」开关（供同步查询 findFollowupDraft 使用）
  useEffect(() => {
    loadWechatDraftsEnabled();
  }, []);
  // 懒挂载：访问过的 tab 保持挂载（切走不卸载，聊天在途请求不丢）
  const [mounted, setMounted] = useState<Record<Tab, boolean>>({
    contacts: true,
    chat: false,
    settings: false,
  });
  const switchTab = (t: Tab) => {
    setMounted((m) => (m[t] ? m : { ...m, [t]: true }));
    setTab(t);
  };

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        {/* 聊天页保持挂载：切 tab 不丢在途请求/输入中的内容 */}
        <View style={[styles.page, tab !== 'contacts' && styles.pageHidden]}>
          {tab === 'contacts' || mounted.contacts ? <ContactsScreen /> : null}
        </View>
        <View style={[styles.page, tab !== 'chat' && styles.pageHidden]}>
          {tab === 'chat' || mounted.chat ? (
            <ChatScreen active={tab === 'chat'} />
          ) : null}
        </View>
        <View style={[styles.page, tab !== 'settings' && styles.pageHidden]}>
          {tab === 'settings' || mounted.settings ? <SettingsScreen /> : null}
        </View>
      </View>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={styles.tabItem}
            onPress={() => switchTab(t.key)}
          >
            <Text style={styles.tabIcon}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f7f8fa' },
  content: { flex: 1 },
  page: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  pageHidden: { display: 'none' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d1d5db',
    backgroundColor: '#fff',
    paddingBottom: 24,
    paddingTop: 8,
  },
  tabItem: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20 },
  tabLabel: { fontSize: 11, color: '#8a8f98', marginTop: 2 },
  tabLabelActive: { color: '#0a7ea4', fontWeight: '600' },
});
