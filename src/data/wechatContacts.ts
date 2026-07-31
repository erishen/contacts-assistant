// 微信好友列表（脱敏占位 / 示例数据）
//
// ⚠️ 本文件为仓库内置的「脱敏示例」，不含任何真实个人信息，可安全提交与开源。
//
// 真实微信好友数据由 scripts/buildWechatData.js 从本地导出的 CSV 生成到
// src/data/wechatContacts.local.ts —— 该文件已被 .gitignore 排除，禁止提交 / 开源（含真实 PII）。
// 克隆仓库、未生成本地数据时，App 使用本占位文件，微信匹配不会命中真实联系人。
//
// 如需在本地启用真实微信匹配：先准备好一份微信好友 CSV（备注名 + 微信ID），再运行
//   node scripts/buildWechatData.js <path-to-wechat.csv>
// 生成的 wechatContacts.local.ts 仅存在于你的机器，不会进入任何版本库。
export type WechatEntry = { n: string; w: string };

export const WECHAT_CONTACTS: WechatEntry[] = [
  { n: '示例张三', w: 'wxid_example_zhangsan' },
  { n: '示例李四-示例科技', w: 'wxid_example_lisi' },
  { n: '示例王五', w: 'example_wangwu' },
  { n: '示例赵六-示例传媒', w: 'wxid_example_zhaoliu' },
  { n: '示例客服', w: 'example_kefu' },
  { n: '示例小美', w: 'wxid_example_xiaomei' },
  { n: '示例陈工', w: 'wxid_example_chengong' },
  { n: '示例刘经理', w: 'wxid_example_liujingli' },
  { n: '示例黄老师', w: 'wxid_example_huanglaoshi' },
  { n: '示例周同学', w: 'wxid_example_zhoutongxue' },
  { n: '示例吴医生', w: 'wxid_example_wuyisheng' },
  { n: '示例郑设计师', w: 'wxid_example_zhengsheji' },
];
