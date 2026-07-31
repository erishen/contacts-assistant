// 微信衍生功能「编译期总开关」。
//
// 由环境变量 EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED 决定，该变量在打包时被 Expo 内联进
// process.env（见 metro.config.js / Makefile）：
//   - 自用包 (make release-self)      => 'true'（或未设置）=> 含全部微信功能
//   - 对外发布包 (make release-public) => 'false'              => 不含任何微信功能
//
// 本常量在编译期即确定。对外发布包中以下代码分支恒为假（或被摇树消除），
// 与「真实微信数据（通讯录匹配 + 跟进草稿）物理不进 bundle」互为双保险：
//   * ContactsScreen 的「有微信 / 最近聊过 / 没聊过」筛选项与列表项微信区、AI 草稿按钮
//   * wechatMatch.findWechat / followupDrafts.findFollowupDraft 的查询入口
export const WECHAT_FEATURES_ENABLED =
  process.env.EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED !== 'false';
