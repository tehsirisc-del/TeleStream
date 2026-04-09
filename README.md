# TeleStream - Project Structure

TeleStream is a multi-platform Telegram Media Player designed for Android TV and Web.

## 🏗 Project Architecture

To ensure clarity for developers and AI assistants, the project is separated into three main layers:

### 1. Backend (Root Directory)
The Node.js server (`server.js`) handles Telegram authentication, media streaming, indexing, and the database.
- **Entry point**: `node server.js`
- **Database**: SQLite (via `database.js`)

### 2. Web UI (`/web`)
The "perfect" Web version of TeleStream. This directory contains all HTML, CSS, and JavaScript assets.
- **Source**: Directly served by the Node.js backend.
- **Built Vendor JS**: Webpack bundles the Telegram browser client into `web/js/vendor/telegram.browser.js`.
- **Note**: This folder is **tracked by Git** to ensure your UI is always backed up.

### 3. Android App (`/android`)
A [Capacitor](https://capacitorjs.com/) wrapper that bundles the `/web` folder into a native Android application.
- **Configuration**: `capacitor.config.json` points to the `web` folder.
- **Build**: Use `npx cap sync` to copy web assets into the Android project before building the APK.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (Recommended: v20+)
- Android Studio (for APK builds)
- A `.env` file with your `TG_API_ID` and `TG_API_HASH`.

### Development Workflow
1. **Frontend Bundle**: If you change the Telegram client logic, run:
   ```bash
   npx webpack
   ```
2. **Configuration**: Generate the frontend config from your `.env`:
   ```bash
   node scripts/generate-config.js
   ```
3. **Run Server**:
   ```bash
   node server.js
   ```
4. **Build APK**:
   ```bash
   npx cap sync
   cd android
   .\gradlew.bat assembleDebug
   ```

---

## 📂 Directories Summary
- `web/`: The frontend source code (HTML/JS/CSS).
- `scripts/`: Build-time scripts.
- `android/`: Native Android project files.
- `Temp-old/`: Backup of old or redundant files (do not delete without verification).
