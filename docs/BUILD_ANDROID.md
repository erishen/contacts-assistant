# 本机构建 Android 安装包（数据不离机）

> 路线：**本地构建**（非 EAS 云构建）。项目（含 `src/data/*.local.ts` 本地私有数据）只在你本机 Mac 上参与编译，真实数据**不离开你的机器**，不上传任何构建服务器。
> 适用：Expo SDK 57 / React Native 0.86 / Android（compileSdk 35）。

---

## 0. 为什么走本地构建（而非 EAS 云构建）
- 本 App 真正能用，依赖磁盘上的本地私有文件 `*.local.ts`（含本地社交账号与若干草稿）。
- 它们被 `.gitignore` 排除。EAS 云构建默认按 `.gitignore` 打包 → 会把这两个文件**排除在上传之外** → 云上打出的 APK 联系人为空、草稿为空（残包）。
- 即使改 `.easignore` 把数据放进去，也会把本地私有数据**上传到 Expo 构建服务器**，违背隐私红线。
- **本地构建**：文件就在你 Mac 磁盘上，`prebuild` 直接把它们打进 APK，数据全程不出本机。代价是你需要装 Android SDK/JDK。

---

## 1. 一次性准备（只需做一次）

### 1.1 JDK 17
React Native 0.86 / Expo 57 需要 **JDK 17**（不是 21）。
```bash
# 用 brew 装（如已装其他版本，用 JAVA_HOME 指到 17）
brew install openjdk@17
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

### 1.2 Android SDK
最省事：装 **Android Studio**（含 SDK Manager），或只装 `cmdline-tools`。
打开 Android Studio → SDK Manager，勾选安装：
- **Android SDK Platform 35**（Expo 57 的 compileSdk）
- **Android SDK Build-Tools 35**
- **Android SDK Platform-Tools**（含 `adb`）
- **Android Emulator**（可选，想用模拟器再装）

设置环境变量（写入 `~/.zshrc` 永久生效）：
```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
```
接受许可：
```bash
sdkmanager --licenses
```

---

## 2. 构建 APK

```bash
# 在项目根目录
cd /path/to/contacts-assistant

# ① 生成原生 android/ 工程（把磁盘上的 .local.ts 打进包；数据不离开本机）
npx expo prebuild --platform android --clean

# ② 进入原生工程目录
cd android

# ③ 出 Debug APK（无需签名，最易侧载安装）
./gradlew assembleDebug
# 首次会下载 Gradle 分发版（需联网，稍慢）
```

产出文件：
```
android/app/build/outputs/apk/debug/app-debug.apk
```

> 若提示 `Permission denied`：先 `chmod +x android/gradlew`。

---

## 3. 装到手机

**方式 A：USB + adb（推荐）**
```bash
# 手机开启「开发者选项 → USB 调试」，USB 连 Mac
adb devices            # 确认看到设备
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**方式 B：拷文件手动装**
把 `app-debug.apk` 传到手机（AirDrop / 数据线 / 任意传输工具），在手机文件管理器里点它 → 允许「未知来源」安装。

> Debug 包即可日常自用；如需上架或长期分发再做 Release 签名（见 §5）。

---

## 4. 改完代码后如何重新出包

- **只改了 JS/TS（界面、逻辑）**：直接重跑 `./gradlew assembleDebug` 即可，Expo 的 Gradle 插件会在 `assemble` 时重新打包 JS bundle，无需再 `prebuild`。
- **改了 app.json / 插件 / 新增原生模块 / 改了 android.package**：先 `npx expo prebuild --platform android --clean` 重新生成原生工程，再 `assembleDebug`。

`android/` 目录是 `prebuild` 生成的，已被 `.gitignore` 忽略，**不要提交它**。

---

## 5. Release 包（打开即用，无需 Metro）

Debug 包必须连 Mac 上的 Metro 才能加载 JS（见 §4 联调）。**Release 包把 JS 直接编进 APK**，手机上点开即用、不依赖电脑，日常自用最省心；数据同样不出本机。

### ✅ 一键出包（推荐）
```bash
make release          # = prebuild --clean + ./gradlew assembleRelease（已自动签名 + 内嵌 JS）
make release-install  # adb 安装 Release APK 到手机
# 或一步到位：
make deploy-release
```
签名与「关 minify / 内嵌 JS」由 `scripts/release-signing.gradle` 在构建时通过 `-I` 注入，**不改动 `android/` 里 prebuild 生成的 `build.gradle`**，所以 `prebuild --clean` 重建后依旧生效。默认**复用 debug 签名**（个人侧载够用，无需单独密钥文件/密码）。

> 产出：`dist/apk/contacts-assistant-self.apk`
>
> Release 产物按身份分文件名，避免拿错包：自用包 `contacts-assistant-self.apk`（含本地数据，禁止分发）、
> 对外发布包 `contacts-assistant-public.apk`（见下节）。构建完成后会自动从 Gradle 输出目录移到 `dist/apk/`，
> 通用文件名 `app-release.apk` 不再留存，杜绝「分不清手上这个包是哪种」。

### 🔒 自用 vs 对外发布（隐私开关编译进包）

两种 Release 包的区别只在「可选本地社交数据衍生功能」是否编进 APK，由编译期变量
`EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED` 决定（该变量在打包时由 Expo 内联进 JS，**改开关必须重新构建才生效**）：

```bash
# 自用：保留可选本地能力（EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=true），你自己有数据、功能可用
make release-self            # 或等价旧名 make release
make deploy-release          # = release-self + 安装

# 对外发布：编译期彻底剔除该模块（EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=false），
# 对外 APK 不含任何可选本地衍生数据代码路径，可分发给他人而无需担心泄露私人语境
make release-public
make deploy-release-public   # = release-public + 安装
make verify-public           # 反编译校验对外包不含真实 PII（分发前必跑）
```

产物按身份分文件名，**两者不会互相覆盖**：

| 包 | 产物路径 | 可否分发 |
|---|---|---|
| 自用 `release-self` | `dist/apk/contacts-assistant-self.apk` | ❌ 含真实本地数据，仅限本机 |
| 对外 `release-public` | `dist/apk/contacts-assistant-public.apk` | ✅ `make verify-public` 通过后可分发 |

`make verify-public` 只校验 public 产物，因此「校验通过」的结论不会被之后的自用构建静默覆盖。

- 自用包（`release-self`）强制 `=true`，不依赖 `.env` 当前值，保证你自己始终能用。
- 对外包（`release-public`）强制 `=false`，做到**两层彻底排除**：
  1. `metro.config.js` 检测到该变量后，把本地私有数据模块（真实数据）**强制解析到脱敏占位**——这些真实数据**物理上不进入 JS bundle**，不是只隐藏 UI；即便对方解包 APK 也拿不到任何真实本地私有数据。
  2. 统一编译期开关被置为 false，`ContactsScreen` 因此**整体收起所有可选本地衍生 UI**：「有社交账号」开关、「最近互动过 / 没互动过」分段、"✍️ AI 草稿"按钮、列表项的相关区与 CSV 的相关列；筛选逻辑同步降级为「仅手机号 / 全部」，不会出现选了"有社交账号"却返回空集的空壳过滤。本地社交数据匹配函数在对外包恒返回 `null`，与 UI 收起互为双保险。
- 两种包都复用 `release-signing.gradle`（debug 签名 + 关 minify + 内嵌 JS），仅 JS 内容不同。
- Release 构建加 `--no-daemon`：保证每次构建拿到全新 JVM 环境，避免复用旧 Gradle daemon 缓存的上一次开关值（否则公/私包可能串味、真实数据漏进对外包）。
- 切换打包类型前建议先 `make clean` 清掉旧的 `android/`，避免 prebuild 缓存串味。

> **对外包也有真 LLM 能力**：`ContactsScreen` 的「✍️ AI 起草」按钮是**与可选本地能力彻底解耦的通用消息起草器**
> （见 `src/utils/contactComposer.ts`），两种包都可用。它只基于「联系人姓名 + 手机号归属地（内置号段表）
> + 你输入的意图 / 场景」让模型生成可直接发送的消息，**不读取也不发送任何本地私有社交数据、
> 不使用私人语境 few-shot**，提示词也不含手机号。因此对外包既发挥了 LLM 价值，又零本地隐私风险。草稿按联系人 id 存本机，
> 可编辑 / 重新生成 / 复制 / 清除。自用包则同时保留更丰富的「✍️ AI 草稿」（基于本地私有社交历史）。

### 🔐 若要做正式发布（独立密钥）
Debug 签名不能上架应用商店。如需用自有密钥：
```bash
# 生成签名密钥（务必保管好，丢失无法更新同一应用）
keytool -genkeypair -v -keystore my-release-key.keystore \
  -alias mykey -keyalg RSA -keysize 2048 -validity 10000
```
把 `my-release-key.keystore` 放到 `android/app/` 下，并在 `android/app/build.gradle` 的 `android { }` 内加：
```gradle
signingConfigs {
    release {
        storeFile file("my-release-key.keystore")
        storePassword System.getenv("KEYSTORE_PASSWORD")
        keyAlias "mykey"
        keyPassword System.getenv("KEYSTORE_PASSWORD")
    }
}
buildTypes.release.signingConfig = signingConfigs.release
```
然后（注意此时不要走上面的 `release-signing.gradle` 注入，避免冲突）：
```bash
export KEYSTORE_PASSWORD=你的密码
cd android && ./gradlew assembleRelease
# 产出：android/app/build/outputs/apk/release/app-release.apk
```
> `*.keystore` 落在 `android/` 内，已被 `.gitignore` 忽略；若放项目根，请自行加入忽略。

---

## 6. 隐私提醒（必读）
- 本 APK **内含你的本地私有社交数据（*.local.ts）**。它只在你本机生成、只装你自己的手机，**不要把这个 APK 分享给任何人、不要上传、不要开源**。
- 本地构建 = 数据不出机；这正是不走 EAS 云构建的原因。
- 真机调试日志（如 `adb logcat`）里若打印了联系人内容，注意别外传。

---

## 7. 排错：Gradle 下载依赖报 `Remote host terminated the handshake`

**现象**：`./gradlew assembleDebug` 卡在下载某个依赖（如 `com.squareup:javapoet:1.13.0` 来自 `plugins.gradle.org/m2`，或 `ktfmt.gradle`、`kotlin-scripting-compiler`、`foojay-resolver` 等），报 `Could not GET 'https://...' > Remote host terminated the handshake`。

**根因**：代理客户端（Clash / ClashX 等）处于**规则模式（Rule Mode）**时，对 Gradle 依次访问的每个域名（plugins.gradle.org、plugins-artifacts.gradle.org、repo.maven.apache.org、dl.google.com 等）**逐个选择性路由**——有的走代理成功，有的被判「直连」被网络掐断握手。这是**打地鼠**：每修一个域名，下一个又挂。

### ✅ 根治方案（已配好，推荐直接用）
思路：**把所有依赖仓库统一重定向到阿里云镜像（单一国内域名 `maven.aliyun.com`），并让该域名直连、完全绕开代理**。这样 Gradle 全程只跟一个国内可达主机打交道，彻底消灭逐域名打地鼠。

已落地的两处配置：

1. **`~/.gradle/init.gradle`**（覆盖全仓库，含 buildscript classpath / pluginManagement / dependencyResolutionManagement）
```gradle
def ALIYUN_PUBLIC = 'https://maven.aliyun.com/repository/public/'
def ALIYUN_GOOGLE = 'https://maven.aliyun.com/repository/google/'
def ALIYUN_GRADLE = 'https://maven.aliyun.com/repository/gradle-plugin/'

allprojects {
    buildscript {
        repositories {
            maven { url ALIYUN_PUBLIC }
            maven { url ALIYUN_GOOGLE }
            maven { url ALIYUN_GRADLE }
        }
    }
    repositories {
        maven { url ALIYUN_PUBLIC }
        maven { url ALIYUN_GOOGLE }
        maven { url ALIYUN_GRADLE }
    }
}

settingsEvaluated { settings ->
    settings.pluginManagement {
        repositories {
            maven { url ALIYUN_GRADLE }
            maven { url ALIYUN_PUBLIC }
            maven { url ALIYUN_GOOGLE }
        }
    }
    def drm = settings.extensions.findByName('dependencyResolutionManagement')
    if (drm != null) {
        drm.repositories {
            maven { url ALIYUN_PUBLIC }
            maven { url ALIYUN_GOOGLE }
            maven { url ALIYUN_GRADLE }
        }
    }
}
```

2. **`~/.gradle/gradle.properties`** 里保留代理声明；`nonProxyHosts` 仅放行本机（**不要**把 `maven.aliyun.com` 加进去——实测本机网络不允许直连出外网，直连阿里云同样被掐断握手，必须走代理）：
```
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=7890
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=7890
systemProp.http.nonProxyHosts=localhost|127.0.0.1
systemProp.https.nonProxyHosts=localhost|127.0.0.1
```

> 改动后务必先停 daemon 再重跑（Gradle 会缓存旧网络配置）：
> ```bash
> cd android && ./gradlew --stop
> make rebuild        # = cd android && ./gradlew assembleDebug
> ```

### ✅ 真正能跑通的组合（关键）
`init.gradle` 把所有仓库收敛到 `maven.aliyun.com` 这一步**保留**，但**必须配合代理全局模式**，让 `maven.aliyun.com` 也经代理隧道出去：

1. 把代理客户端（Clash / ClashX 等）切到 **Global Mode（全局模式）**，并**重启一下代理客户端**确保生效。
2. 确认 `~/.gradle/gradle.properties` 里 `maven.aliyun.com` **不在** `nonProxyHosts` 中（即走代理）。
3. 停 daemon 重跑：
   ```bash
   cd android && ./gradlew --stop
   make rebuild
   ```
   全程保持全局代理，直到看到 `BUILD SUCCESSFUL` 再切回规则模式。已下载的依赖有缓存，从断点续传。

> 为什么规则模式不行、全局才行：规则模式下代理对每个域名单独判「代理 or 直连」，而本机直连出不了外网 → 被判直连的域名一律握手被掐（打地鼠）。全局模式下所有域名统一走代理隧道（CONNECT），`maven.aliyun.com` 也能正常解析。

> 补充：`~/.gradle/gradle.properties` 与 `init.gradle` 均为全局配置，对所有 Gradle 项目生效；`android/gradle.properties`（prebuild 生成）无 proxy 键，会正确 fallback 到全局。
