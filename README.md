# Contacts Assistant

A **local-first** contacts companion app built with Expo / React Native (Android). It reads your phone contacts on-device, then layers privacy-conscious AI helpers on top: draft messages, infer how to approach a contact, keep local notes, and search with natural language.

All contact data stays on your device. AI features send **only** name + carrier region (a city name derived from the phone prefix) + your intent to the model — never the phone number, email, or full address book.

---

## Features

| Area | What it does |
| --- | --- |
| **Contacts** | Read the device address book via `expo-contacts`, de-duplicated by phone number, searchable/filterable. |
| **AI Draft** (`✍️`) | Generate a message draft from a goal + scenario (small talk / invite / greet / apologize / business) + optional relation note. Uses given name only, never the full name. |
| **AI Persona** (`💡`) | "How to approach this person" — relationship framing, tone advice, and an icebreaker example, given your own profile. |
| **Local Notes** (`📝`) | Per-contact private notes stored on-device (AsyncStorage). |
| **Smart Search** | Natural-language filtering — describe who you want (e.g. "上海的朋友") and an LLM resolves the matching contacts. |
| **Chat** | A standalone multi-turn LLM chat that uses your main settings config; history persists locally. |
| **Export** | Export the (de-duplicated) contact list to **CSV**, or a **Markdown profile** (name / phone / email / notes / persona / draft) for sharing. |
| **Settings** | LLM provider config (20+ built-in OpenAI-compatible presets), API key in system secure storage, and an "About me" profile (your gender / how you'd like to be addressed) that tunes drafts and advice. |

> The AI helpers are fully decoupled from any social-data extension — they work in both the self build and the public build using only name + region + your own inputs.

---

## Tech stack

- **Expo SDK 57** · **React Native 0.86** · **React 19** · **TypeScript**
- `expo-contacts` (on-device address book), `expo-secure-store` (API key), `expo-file-system` + `expo-sharing` (export), `@react-native-async-storage/async-storage` (notes / drafts / chat history)
- LLM calls use the OpenAI-compatible `/chat/completions` interface; provider presets are configurable in `src/config/providers.ts`.

---

## Requirements

- **Node.js** 18+ (developed on 22.x)
- **Expo CLI** (`npx expo`)
- For a local Android build / release:
  - **JDK 17**
  - **Android SDK** with `ANDROID_HOME` set, `compileSdk 35`
  - `apktool` (only needed for `make verify-public`)

---

## Getting started (development)

```bash
# 1. install dependencies
npm install

# 2. configure your LLM endpoint
cp .env.example .env        # then edit EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED if needed
#    (default false = public-safe; set true for the self build with local data)

# 3. start the dev server (connect your phone via Expo Go / a dev build)
npm start

# 4. type-check
npx tsc --noEmit            # or: make typecheck
```

Open the app on an Android device/emulator, grant contacts permission, and configure a provider + API key under **Settings**.

---

## Building Android (self vs public)

The repo ships a `Makefile` that wraps Expo's local Android build. The key distinction is whether the **optional local social-data extension** is compiled into the package:

| Target | Use | `EXPO_PUBLIC_WECHAT_DRAFTS_ENABLED` |
| --- | --- | --- |
| `make release-self` | Your own device. Keeps the private local-data capability. | `true` |
| `make release-public` | Distribute to others. Compiled-out, zero private data paths. | `false` |

```bash
make help                      # list all targets

# Quick dev loop (needs Metro running):
make build && make install     # debug APK → adb install

# Self release (private local data in the package):
make deploy-release            # release-self + adb install

# Public release (safe to share):
make clean && make deploy-release-public   # release-public + adb install
make verify-public             # decompile the APK and scan for leaked private data
```

`make verify-public` runs `scripts/verify-no-pii.sh`, which decompiles the public APK and asserts that no real social account IDs made it into the bundle. **Only distribute the APK after it prints `PASS`.**

> Full walkthrough: [`docs/BUILD_ANDROID.md`](docs/BUILD_ANDROID.md).

---

## Privacy design (summary)

This app is built around **local-first** handling of real personal information. See [`PRIVACY.md`](PRIVACY.md) for the full policy. Highlights:

1. **Local-first** — the address book is read and filtered on-device; nothing is uploaded to any server.
2. **Minimal outbound scope** — AI features send only name + region + intent. Phone numbers, emails, and the full address book are never sent to the model.
3. **Key isolation** — the LLM API key lives in the OS secure store (Keychain / Keystore); it is never written to a file, committed, or logged.
4. **Private data never in the repo** — local data files (`*.local.ts`), CSV exports, `.env`, and signing keys are all excluded by `.gitignore`.
5. **Public build is provably clean** — in the public build, `metro.config.js` resolves the local-data modules to desensitized placeholders, and the optional extension is removed at compile time (tree-shaking). `make verify-public` confirms it.

> The optional local social-data extension is **self-build only**. Public releases and clean clones contain none of it, and the code path is removed at build time — no code changes needed to stay safe.

---

## Project structure

```
contacts-assistant/
├── App.tsx                      # tab navigation (Contacts / Chat / Settings)
├── Makefile                     # dev + Android build + privacy verification
├── metro.config.js              # public-build placeholder resolution
├── PRIVACY.md                   # privacy policy
├── docs/
│   └── BUILD_ANDROID.md         # local Android build guide
├── scripts/
│   └── verify-no-pii.sh         # decompile + scan public APK for leaked PII
└── src/
    ├── config/providers.ts      # LLM provider presets
    ├── data/                    # desensitized placeholders (real data is *.local.ts, gitignored)
    ├── screens/                 # ContactsScreen / ChatScreen / SettingsScreen
    └── utils/                   # composer, insight, notes, search, export, llm client, ...
```

---

---

## Related Articles

- English: [contacts_assistant: Personal CRM AI Follow-up Assistant](https://erishen.cn/contacts_assistant-en/)
- 中文: [contacts_assistant：个人联系人 AI 跟进助手](https://erishen.cn/contacts_assistant/)

## License

MIT — see [`LICENSE`](LICENSE).
