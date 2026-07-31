# renmai-assistant Makefile
# 封装 Expo 开发 / 类型检查 / 本机 Android 构建（真实微信数据不出本机）
# 完整说明见 docs/BUILD_ANDROID.md
#
# Release 包分两种（核心区别 = 微信聊天记录衍生功能是否编译进包）：
#   - release-self    ：自用。EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=true，保留私人语境能力。
#   - release-public  ：对外发布。EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=false，
#                       编译期彻底剔除该模块，对外 APK 不含任何微信衍生数据代码路径。
#   （该变量由 Expo 在打包时内联进 process.env，故「改开关必须重新构建才生效」。）
#
# 两种包的产物**文件名不同**（dist/apk/*-self.apk 与 *-public.apk），构建后自动从 Gradle
# 输出目录移走、不保留通用名 app-release.apk —— 避免两种包互相覆盖导致误分发，
# 也保证 `make verify-public` 的「校验通过」结论不会被之后的自用构建静默作废。

NPX        ?= npx
TSC        ?= ./node_modules/.bin/tsc
EXPO       ?= $(NPX) expo
GRADLEW    ?= ./gradlew
APK_DEBUG  ?= android/app/build/outputs/apk/debug/app-debug.apk
# Gradle 原始产物路径：self / public 构建都会写到这里、彼此覆盖，
# 因此构建完成后一律 mv 到 dist/apk 下带身份的文件名，杜绝「分不清手上这个包是哪种」。
APK_GRADLE_OUT ?= android/app/build/outputs/apk/release/app-release.apk
DIST_DIR   ?= dist/apk
# 自用包：含真实私人数据，仅限本机安装，禁止分发
APK_SELF   ?= $(DIST_DIR)/contacts-assistant-self.apk
# 对外发布包：编译期已剔除私人数据模块，校验通过后方可分发
APK_PUBLIC ?= $(DIST_DIR)/contacts-assistant-public.apk
RELEASE_INIT ?= scripts/release-signing.gradle
# 微信衍生功能编译期开关：自用=true（保留），对外发布=false（剔除）
DRAFTS_SELF   ?= true
DRAFTS_PUBLIC ?= false

.DEFAULT_GOAL := help

.PHONY: help start dev typecheck prebuild build rebuild install deploy clean \
        release release-self release-install deploy-release \
        release-public release-public-install deploy-release-public verify-public

help:
	@echo "renmai-assistant 可用目标："
	@echo "  make start          启动 Expo dev server（手机 / 模拟器连调）"
	@echo "  make dev            同 start"
	@echo "  make typecheck      运行 tsc --noEmit 类型检查"
	@echo "  make prebuild       生成原生 android/ 工程（把 .local.ts 打进包）"
	@echo "  make build          prebuild + 出 Debug APK（完整重出；Debug 需 Metro 连调）"
	@echo "  make rebuild        仅重新打包 JS 出 APK（已 prebuild 过、只改了 JS 时用，更快）"
	@echo "  make install        adb 安装已有 Debug APK 到手机（需 USB 调试 + Metro）"
	@echo "  make deploy         build + install 一步到位"
	@echo "  make release / release-self   自用 Release（含微信衍生功能，EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=true）"
	@echo "  make release-install          adb 安装自用 Release APK"
	@echo "  make deploy-release           release-self + release-install 一步到位"
	@echo "  make release-public           对外发布 Release（编译剔除微信衍生功能，false，零私人数据代码路径）"
	@echo "  make release-public-install   adb 安装对外发布 Release APK"
	@echo "  make deploy-release-public     release-public + release-public-install 一步到位"
	@echo "  make verify-public            反编译校验对外发布包不含真实 PII（分发前必跑）"
	@echo "  make clean          删除 prebuild 生成的 android/ 目录"
	@echo ""
	@echo "Release 产物（两种包文件名不同，避免误分发）："
	@echo "  自用（禁止分发）: $(APK_SELF)"
	@echo "  对外发布       : $(APK_PUBLIC)"
	@echo ""
	@echo "前置：JDK 17 + Android SDK（ANDROID_HOME）。详见 docs/BUILD_ANDROID.md"

start dev:
	$(EXPO) start

typecheck:
	$(TSC) --noEmit

prebuild:
	$(EXPO) prebuild --platform android --clean

build: prebuild
	@chmod +x android/gradlew 2>/dev/null || true
	cd android && $(GRADLEW) assembleDebug
	@echo "Debug APK: $(APK_DEBUG)"

rebuild:
	@chmod +x android/gradlew 2>/dev/null || true
	cd android && $(GRADLEW) assembleDebug
	@echo "Debug APK: $(APK_DEBUG)"

install:
	adb install -r $(APK_DEBUG)

deploy: build install

# ===== 自用 Release（保留微信衍生功能）=====
# 强制 EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=true，不依赖 .env 当前值，保证自用包始终带私人语境能力。
# 该变量在 gradlew 进程环境里设置，会被 RN 打包（Metro）继承并内联进 JS，故开关编译进包。
# --no-daemon：保证每次构建拿到全新 JVM 环境，避免复用旧 daemon 缓存的上一次开关值（否则公/私包可能串味）。
release-self: prebuild
	@chmod +x android/gradlew 2>/dev/null || true
	@rm -f $(APK_GRADLE_OUT)
	cd android && EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=$(DRAFTS_SELF) $(GRADLEW) --no-daemon assembleRelease -I ../$(RELEASE_INIT)
	@mkdir -p $(DIST_DIR)
	@mv -f $(APK_GRADLE_OUT) $(APK_SELF)
	@echo "自用 Release APK（含微信衍生功能，含真实私人数据）: $(APK_SELF)"
	@echo "⚠️  该包仅限本机安装，禁止分发；对外分发请用 make release-public"

# 兼容旧名：make release = 自用
release: release-self
	@true

release-install:
	adb install -r $(APK_SELF)

deploy-release: release release-install

# ===== 对外发布 Release（编译期剔除微信衍生功能 + 私有数据不进包）=====
# 强制 EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=false：
#   - followupDrafts.ts 里 FEATURE_ENABLED=false → UI 不展示该模块；
#   - metro.config.js 检测到该变量 → 把 wechatContacts.local / followupDrafts.local
#     强制解析到脱敏占位，真实微信 PII 与私人语境草稿【物理上不进入 JS bundle】。
# 对外 APK 不含任何微信衍生数据，可分发给他人而无需担心泄露私人语境。
release-public: prebuild
	@chmod +x android/gradlew 2>/dev/null || true
	@rm -f $(APK_GRADLE_OUT)
	cd android && EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED=$(DRAFTS_PUBLIC) $(GRADLEW) --no-daemon assembleRelease -I ../$(RELEASE_INIT)
	@mkdir -p $(DIST_DIR)
	@mv -f $(APK_GRADLE_OUT) $(APK_PUBLIC)
	@echo "对外发布 Release APK（已剔除微信衍生功能，零私人数据）: $(APK_PUBLIC)"
	@echo "分发前请先跑: make verify-public"

release-public-install:
	adb install -r $(APK_PUBLIC)

deploy-release-public: release-public release-public-install

# 对外发布包构建后，自动反编译校验是否混入真实微信 PII（需 apktool: brew install apktool）
# 只校验 public 产物：self 包走独立文件名，不会被误当成"已校验通过"的包分发。
verify-public:
	@test -f $(APK_PUBLIC) || { echo "ERROR: 找不到对外发布包 $(APK_PUBLIC)，请先运行 make release-public"; exit 2; }
	@bash scripts/verify-no-pii.sh $(APK_PUBLIC)

clean:
	rm -rf android
	@echo "已删除 android/（prebuild 生成物，可重新 prebuild 生成）"
