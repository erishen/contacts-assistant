const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// 基于 Expo 默认配置扩展，新增「本地私有数据」解析控制。
const config = getDefaultConfig(__dirname);

// 对外发布构建（EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED === 'false'）时，
// 把本地私有数据模块（wechatContacts.local 含真实微信 PII / followupDrafts.local 含私人语境草稿）
// 强制解析到脱敏占位——不仅 UI 不展示，而是【物理上不进入 JS bundle】。
// 这样对外 APK 里不存在任何真实微信数据，即便被人解包也拿不到。
// 注：该变量由 Makefile 在 `cd android && EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=... ./gradlew` 注入，
// 在 Metro 进程（RN bundle）的环境里可见；配合 Makefile 的 --no-daemon 避免 daemon 缓存旧环境变量。
const PUBLIC_BUILD = process.env.EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED === 'false';

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // 本地真实微信数据（wechatContacts.local）：仓库中不存在（.gitignore 排除，含真实 PII）。
  // - 对外发布：一律兜底到脱敏占位 wechatContacts.ts，真实数据不进包；
  // - 自用 / 文件缺失：使用默认解析器加载真实数据，失败再兜底占位，保证可独立构建。
  if (moduleName.endsWith('wechatContacts.local')) {
    if (PUBLIC_BUILD) {
      return {
        filePath: path.resolve(__dirname, 'src/data/wechatContacts.ts'),
        type: 'sourceFile',
      };
    }
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch (e) {
      return {
        filePath: path.resolve(__dirname, 'src/data/wechatContacts.ts'),
        type: 'sourceFile',
      };
    }
  }
  // 本地预生成跟进草稿（followupDrafts.local）：同 wechatContacts.local 的解析控制。
  if (moduleName.endsWith('followupDrafts.local')) {
    if (PUBLIC_BUILD) {
      return {
        filePath: path.resolve(__dirname, 'src/data/followupDrafts.ts'),
        type: 'sourceFile',
      };
    }
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch (e) {
      return {
        filePath: path.resolve(__dirname, 'src/data/followupDrafts.ts'),
        type: 'sourceFile',
      };
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
