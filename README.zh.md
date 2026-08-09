# 通讯录助手（Contacts Assistant）

一个**本地优先**的通讯录辅助 App，基于 Expo / React Native（Android）构建。它在你的设备上读取手机通讯录，并在其上叠加注重隐私的 AI 辅助能力：起草消息、推断"该怎么和这个人打交道"、记下本地备注、用自然语言查找联系人。

所有联系人数据都保留在你的设备上。AI 功能只向模型发送**姓名 + 手机号归属地（由号段推断出的城市名）+ 你的意图**——绝不发送手机号、邮箱或完整通讯录。

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| **通讯录** | 通过 `expo-contacts` 在本机读取通讯录，按手机号去重，可搜索 / 筛选。 |
| **AI 起草**（`✍️`） | 根据「目标 + 场景（寒暄 / 邀约 / 问候 / 致歉 / 商务）+ 可选关系备注」生成消息草稿。只用名字、不直呼全名。 |
| **AI 画像**（`💡`） | "怎么和这个人打交道"——关系定位、沟通分寸建议、破冰示例，结合你自己的「关于我」设定。 |
| **本地备注**（`📝`） | 每个联系人独立的私有备注，存储在本机（AsyncStorage）。 |
| **智能查找** | 自然语言筛选——描述你想找的人（如"上海的朋友"），由 LLM 解析匹配结果。 |
| **聊天** | 独立的多轮 LLM 对话，复用「设置」里的主要配置；历史记录本地持久化。 |
| **导出** | 将（已去重的）联系人导出为 **CSV**，或导出 **Markdown 档案**（姓名 / 手机 / 邮箱 / 备注 / 画像 / 草稿）便于分享。 |
| **设置** | LLM 服务商配置（内置 20+ 个 OpenAI 兼容预设）、API Key 存于系统安全存储、以及「关于我」档案（你的性别 / 希望被如何称呼）用于调校草稿与建议。 |

> AI 辅助能力与任何本地社交数据扩展完全解耦——它们仅使用姓名 + 归属地 + 你自己的输入，在自用构建与对外发布构建中均可使用。

---

## 技术栈

- **Expo SDK 57** · **React Native 0.86** · **React 19** · **TypeScript**
- `expo-contacts`（本机通讯录）、`expo-secure-store`（API Key）、`expo-file-system` + `expo-sharing`（导出）、`@react-native-async-storage/async-storage`（备注 / 草稿 / 聊天历史）
- LLM 调用采用 OpenAI 兼容的 `/chat/completions` 接口；服务商预设可在 `src/config/providers.ts` 中配置。

---

## 环境要求

- **Node.js** 18+（开发环境为 22.x）
- **Expo CLI**（`npx expo`）
- 本地构建 / 出 Android 包还需：
  - **JDK 17**
  - **Android SDK**（已设置 `ANDROID_HOME`，`compileSdk 35`）
  - `apktool`（仅 `make verify-public` 需要）

---

## 快速开始（开发）

```bash
# 1. 安装依赖
npm install

# 2. 配置 LLM 接口
cp .env.example .env        # 按需修改 EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED
#    （默认 false = 对外安全；true 为启用本地数据的自用构建）

# 3. 启动开发服务器（通过 Expo Go / 开发版连接手机）
npm start

# 4. 类型检查
npx tsc --noEmit            # 或：make typecheck
```

在 Android 设备 / 模拟器上打开 App，授予通讯录权限，并在「设置」中配置服务商与 API Key。

---

## 构建 Android（自用 vs 对外发布）

仓库自带 `Makefile`，封装了 Expo 的本地 Android 构建。核心区别在于：**可选的本地社交数据扩展**是否被编译进安装包。

| 目标 | 用途 | `EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED` |
| --- | --- | --- |
| `make release-self` | 自己的设备。保留私有本地数据能力。 | `true` |
| `make release-public` | 分发给他人。编译期剔除，零私人数据代码路径。 | `false` |

```bash
make help                      # 列出全部目标

# 快速开发循环（需 Metro 运行）：
make build && make install     # 出 Debug APK → adb 安装

# 自用 Release（包内含私有本地数据）：
make deploy-release            # release-self + adb install

# 对外发布 Release（可安全分享）：
make clean && make deploy-release-public   # release-public + adb install
make verify-public             # 反编译 APK 并扫描是否混入真实私人数据
```

`make verify-public` 会执行 `scripts/verify-no-pii.sh`，反编译对外 APK 并断言其中不含任何真实社交账号 ID。**仅当打印 `PASS` 后才可分发。**

> 完整流程见 [`docs/BUILD_ANDROID.md`](docs/BUILD_ANDROID.md)。

---

## 隐私设计（摘要）

本 App 以**本地优先**原则处理真实个人信息。完整策略见 [`PRIVACY.md`](PRIVACY.md)。要点：

1. **本地优先**——通讯录在本机读取与筛选，不上传任何服务器。
2. **最小外发**——AI 功能只发送姓名 + 归属地 + 意图，手机号、邮箱、完整通讯录绝不发给模型。
3. **密钥隔离**——LLM 的 API Key 存于系统安全存储（Keychain / Keystore），不落明文文件、不进版本库、不出现在日志。
4. **私有数据不进仓库**——本地数据文件（`*.local.ts`）、CSV 导出、`.env`、签名密钥均被 `.gitignore` 排除。
5. **对外发布包可被验证为干净**——公共构建下 `metro.config.js` 将对本地数据模块强制解析到脱敏占位，可选扩展在编译期被 tree-shaking 移除；`make verify-public` 兜底确认。

> 可选的本地社交数据扩展**仅限自用构建**。对外发布版与干净克隆均不含此功能，相关代码路径在构建期被移除——无需改代码即可天然安全。

---

## 目录结构

```
contacts-assistant/
├── App.tsx                      # 底部 tab 导航（通讯录 / 聊天 / 设置）
├── Makefile                     # 开发 + Android 构建 + 隐私校验
├── metro.config.js              # 对外构建的占位解析
├── PRIVACY.md                   # 隐私策略
├── docs/
│   └── BUILD_ANDROID.md         # 本地 Android 构建指南
├── scripts/
│   └── verify-no-pii.sh         # 反编译 + 扫描对外 APK 是否泄露 PII
└── src/
    ├── config/providers.ts      # LLM 服务商预设
    ├── data/                    # 脱敏占位（真实数据在 *.local.ts，已被 gitignore）
    ├── screens/                 # ContactsScreen / ChatScreen / SettingsScreen
    └── utils/                   # 起草、画像、备注、查找、导出、LLM 客户端……
```

---

## 许可证

MIT —— 见 [`LICENSE`](LICENSE)。

---

## 相关文章
- [本地优先的 AI 通讯录助手：把大模型请进地址簿，数据却不离家](https://erishen.cn/contacts_assistant/)
