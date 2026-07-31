// 通讯录数据缓存：
// - 设备通讯录读取很慢（Contact.getAll + 逐联系人 getDetails），每次冷启动/下拉刷新都重读体验差；
// - 这里把「已处理好的 ContactItem[]」缓存到内存 + AsyncStorage，冷启动秒开；
// - 设置页的「清除缓存 / 重新获取最新」通过订阅机制通知（仍挂载但隐藏的）通讯录页重载。
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ContactItem } from '../screens/ContactsScreen';

const KEY = 'contacts.cache.v1';

let memory: ContactItem[] | null = null;
const listeners = new Set<() => void>();
let forceRefetch = false;

/** 订阅缓存变更（清除/刷新信号），返回取消订阅函数 */
export function subscribeContactsCache(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  listeners.forEach((cb) => cb());
}

/** 读取缓存；内存优先，否则读 AsyncStorage。无缓存或损坏返回 null */
export async function loadCachedContacts(): Promise<ContactItem[] | null> {
  if (memory) return memory;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        memory = parsed as ContactItem[];
        return memory;
      }
    }
  } catch {
    // 缓存损坏：当无缓存处理
  }
  return null;
}

/** 写入缓存：内存 + 磁盘双写 */
export async function saveContactsCache(items: ContactItem[]): Promise<void> {
  memory = items;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // 配额/不可用：忽略，至少内存有
  }
}

/** 清除缓存（内存 + 磁盘），并触发一次强制从设备重载 */
export async function clearContactsCache(): Promise<void> {
  memory = null;
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  requestForceRefetch();
}

/** 请求一次从设备的强制刷新（忽略缓存），由「重新获取最新」调用 */
export function requestContactsRefresh(): void {
  requestForceRefetch();
}

function requestForceRefetch(): void {
  forceRefetch = true;
  notify();
}

/** 消费强制刷新信号（取后即清） */
export function consumeForceRefetch(): boolean {
  const v = forceRefetch;
  forceRefetch = false;
  return v;
}
