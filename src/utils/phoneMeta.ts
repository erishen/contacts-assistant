// 手机号归属地 / 运营商查询（离线，零网络、零权限）
// 数据：phoneData.ts 内嵌的 phone.dat（xluohome/phonedata，经典二进制格式）
// 算法：base64 解码为 Uint8Array -> 在索引区二分查找前 7 位 -> 读取归属地文本
import { PHONE_DAT_B64 } from './phoneData';

export type PhoneMeta = {
  province: string;
  city: string;
  operator: string;
};

const CARD_TYPES: Record<number, string> = {
  1: '中国移动',
  2: '中国联通',
  3: '中国电信',
  4: '中国电信虚拟运营商',
  5: '中国联通虚拟运营商',
  6: '中国移动虚拟运营商',
  7: '中国广电',
  8: '中国广电虚拟运营商',
};

const IDX_ENTRY = 9; // 每条索引 9 字节：前7位(4) + 记录偏移(4) + 运营商(1)
const cache = new Map<string, PhoneMeta | null>();
let buf: Uint8Array | null = null;

/** 懒解码：首次调用时把 base64 转成 Uint8Array 并缓存 */
function getBuf(): Uint8Array {
  if (buf) return buf;
  buf = base64ToBytes(PHONE_DAT_B64);
  return buf;
}

/** 手写 base64 -> Uint8Array，避免依赖运行时的 atob（RN 不一定有） */
function base64ToBytes(b64: string): Uint8Array {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Int32Array(256).fill(-1);
  for (let i = 0; i < abc.length; i++) lut[abc.charCodeAt(i)] = i;
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let value = 0;
  let bits = 0;
  let oi = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lut[clean.charCodeAt(i)];
    if (v < 0) continue;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, oi);
}

/** 小端读 4 字节无符号整数 */
function get4(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** UTF-8 解码（中文为 3 字节，走 BMP 分支即可） */
function utf8Decode(b: Uint8Array, start: number, end: number): string {
  let s = '';
  let i = start;
  while (i < end) {
    const c = b[i++];
    if (c < 0x80) {
      s += String.fromCharCode(c);
    } else if (c < 0xe0) {
      s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    } else if (c < 0xf0) {
      s += String.fromCharCode(
        ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f),
      );
    } else {
      const cp =
        ((c & 0x07) << 18) |
        ((b[i++] & 0x3f) << 12) |
        ((b[i++] & 0x3f) << 6) |
        (b[i++] & 0x3f);
      const c2 = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (c2 >> 10), 0xdc00 + (c2 & 0x3ff));
    }
  }
  return s;
}

/** 号码前 3 位 -> 基础运营商（号段库未覆盖时的兜底） */
function operatorByPrefix3(prefix3: string): string | null {
  const n = prefix3;
  if (['134', '135', '136', '137', '138', '139', '147', '148', '150', '151', '152', '157', '158', '159', '165', '172', '178', '182', '183', '184', '187', '188', '195', '197', '198'].includes(n)) return '中国移动';
  if (['130', '131', '132', '145', '146', '155', '156', '166', '167', '171', '175', '176', '185', '186', '196'].includes(n)) return '中国联通';
  if (['133', '149', '153', '162', '173', '174', '177', '180', '181', '189', '190', '191', '193', '199'].includes(n)) return '中国电信';
  if (n === '192') return '中国广电';
  return null;
}

/** 归一化：去分隔符、去 +86/86/0086 前缀，返回纯数字 */
function normalize(raw: string): string {
  let d = raw.replace(/[^\d]/g, '');
  d = d.replace(/^0086/, '').replace(/^86/, '');
  return d;
}

/**
 * 查询手机号归属地（离线）。
 * @returns 命中数据库则返回 {province, city, operator}；
 *          数据库未覆盖但可推断运营商则返回 operator 兜底；
 *          无法识别返回 null。
 */
export function getPhoneMeta(raw: string): PhoneMeta | null {
  const digits = normalize(raw);
  if (digits.length < 7) return null;
  const eleven = digits.length >= 11 ? digits.slice(0, 11) : digits;
  const prefix7 = parseInt(eleven.slice(0, 7), 10);
  if (!Number.isFinite(prefix7)) return null;

  const hit = cache.get(eleven.slice(0, 7));
  if (hit !== undefined) return hit;

  const b = getBuf();
  const firstoffset = get4(b, 4);
  const total = b.length;
  let left = 0;
  let right = Math.floor((total - firstoffset) / IDX_ENTRY) - 1;
  let recOff = -1;
  let card = 0;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const io = firstoffset + mid * IDX_ENTRY;
    const cur = get4(b, io);
    if (cur > prefix7) right = mid - 1;
    else if (cur < prefix7) left = mid + 1;
    else {
      recOff = get4(b, io + 4);
      card = b[io + 8];
      break;
    }
  }

  let result: PhoneMeta | null;
  if (recOff < 0) {
    const op = operatorByPrefix3(eleven.slice(0, 3));
    result = op ? { province: '', city: '', operator: op } : null;
  } else {
    let end = recOff;
    while (end < total && b[end] !== 0) end++;
    const parts = utf8Decode(b, recOff, end).split('|');
    const op =
      CARD_TYPES[card] ?? operatorByPrefix3(eleven.slice(0, 3)) ?? '未知';
    result = { province: parts[0] ?? '', city: parts[1] ?? '', operator: op };
  }
  cache.set(eleven.slice(0, 7), result);
  return result;
}
