#!/usr/bin/env bash
#
# verify-no-pii.sh —— 对外发布包（public）隐私校验
#
# 在 `make deploy-release-public` 之后运行，自动反编译 APK，
# 检查 JS bundle 中是否混入了真实微信 ID（wxid_ / example_ 非占位）。
# 若发现疑似真实 PII → 退出码 1（FAIL，请勿分发）；否则 PASS。
#
# 用法：
#   bash scripts/verify-no-pii.sh [apk路径，默认 android/app/build/outputs/apk/release/app-release.apk]
#
# 依赖：apktool（macOS: brew install apktool）
#
set -euo pipefail

APK="${1:-android/app/build/outputs/apk/release/app-release.apk}"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "== 对外发布包 PII 校验 =="

if [ ! -f "$APK" ]; then
  echo "ERROR: 找不到 APK: $APK"
  echo "请先运行: make clean && make deploy-release-public"
  exit 2
fi

if ! command -v apktool >/dev/null 2>&1; then
  echo "ERROR: 需要 apktool（macOS: brew install apktool）"
  exit 2
fi

echo "反编译 $APK ..."
apktool d -f -o "$WORK/decompiled" "$APK" >/dev/null 2>&1

# 收集 JS bundle（Expo/RN release 通常位于 assets/index.android.bundle）
mapfile -t JS_FILES < <(find "$WORK/decompiled" -type f \( -name "*.bundle" -o -name "*.js" \) 2>/dev/null)
if [ "${#JS_FILES[@]}" -eq 0 ]; then
  echo "WARN: 未找到 JS bundle，无法校验"
  exit 3
fi
echo "扫描 JS 文件: ${#JS_FILES[@]} 个"

LEAK=0

# 占位白名单：仓库内置脱敏示例（src/data/wechatContacts.ts 的 12 条）
EXAMPLE_WHITELIST="zhangsan|lisi|wangwu|zhaoliu|kefu|xiaomei|chengong|liujingli|huanglaoshi|zhoutongxue|wuyisheng|zhengsheji"

for f in "${JS_FILES[@]}"; do
  # 1) wxid_ 开头但非 wxid_example_*（占位）的 → 疑似真实微信 ID
  hits=$(grep -oE "wxid_[a-zA-Z0-9_-]+" "$f" | grep -vE "^wxid_example_" | sort -u || true)
  if [ -n "$hits" ]; then
    echo "FAIL: 在 $f 发现疑似真实微信 ID (wxid_):"
    echo "$hits"
    LEAK=1
  fi

  # 2) example_ 开头但不在占位白名单 → 疑似真实（真实微信极少用 example_ 前缀，此为兜底）
  ex_hits=$(grep -oE "example_[a-zA-Z0-9_-]+" "$f" | grep -vE "example_(${EXAMPLE_WHITELIST})" | sort -u || true)
  if [ -n "$ex_hits" ]; then
    echo "FAIL: 在 $f 发现非占位 example_ ID:"
    echo "$ex_hits"
    LEAK=1
  fi
done

# 校验 metro 占位替换是否生效：占位 wxid 至少应出现在 bundle 中（说明 .local 被替换为脱敏数据）
PLACEHOLDER_FOUND=0
for f in "${JS_FILES[@]}"; do
  if grep -q "wxid_example_zhangsan" "$f"; then
    PLACEHOLDER_FOUND=1
    break
  fi
done

if [ "$LEAK" -eq 1 ]; then
  echo ""
  echo "== 结果: FAIL —— 发现疑似真实微信 PII，请勿分发该 APK =="
  exit 1
fi

echo ""
if [ "$PLACEHOLDER_FOUND" -eq 1 ]; then
  echo "== 结果: PASS —— 未检测到真实微信 ID；占位代码路径仍存在（仅脱敏数据，无 PII）=="
else
  echo "== 结果: PASS —— 未检测到任何微信 ID（metro 占位替换已彻底消除微信代码路径）=="
fi
exit 0
