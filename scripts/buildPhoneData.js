#!/usr/bin/env node
// 重新生成本地号段数据库（src/utils/phoneData.ts）
// 用法：node scripts/buildPhoneData.js [/path/to/phone.dat]
// phone.dat 来源：https://github.com/xluohome/phonedata （经典二进制格式）
// 下载示例：curl -L -o phone.dat https://cdn.jsdelivr.net/gh/xluohome/phonedata@master/phone.dat
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || '/tmp/phone.dat';
if (!fs.existsSync(src)) {
  console.error('找不到 phone.dat，请先下载后传入路径');
  process.exit(1);
}

const buf = fs.readFileSync(src);
const b64 = buf.toString('base64');
const version = buf.toString('latin1', 0, 4);
const firstoffset = buf.readUInt32LE(4);
const idxCount = Math.floor((buf.length - firstoffset) / 9);

let sorted = true;
for (let i = 1; i < idxCount; i++) {
  const a = buf.readUInt32LE(firstoffset + (i - 1) * 9);
  const b = buf.readUInt32LE(firstoffset + i * 9);
  if (b < a) { sorted = false; break; }
}
if (!sorted) {
  console.error('警告：索引区未升序，二分查找可能失败');
}

const out =
`// 手机号段归属地数据库（离线）
// 数据来源：xluohome/phonedata (https://github.com/xluohome/phonedata) phone.dat
// 数据版本：${version}（2023-02 公开整理，公共数据集）
// 格式：经典 phone.dat 二进制，base64 内嵌；运行时解码后二分查找。
// 请勿手改；更新数据请替换 phone.dat 后重新生成本文件。
export const PHONE_DAT_VERSION = '${version}';
export const PHONE_DAT_B64 = '${b64}';
`;

const target = path.join(__dirname, '..', 'src', 'utils', 'phoneData.ts');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log('已生成', target, '| 版本', version, '| 号段', idxCount, '| 文件', out.length, '字节');
