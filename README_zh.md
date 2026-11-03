# LibreTV Android TV 封装工程（源码整合版）

本目录已整合用户提供的 LibreTV 2.21.1 源码 ZIP 与 Android TV WebView 外壳，并完成电视版前端的首轮改造。

## 当前已完成

- 将 LibreTV 2.21.1 前端完整源码放入 `frontend/`，保留原项目 LICENSE、锁文件、组件、播放器、源管理、历史与设置等模块。
- 将原生 Android TV WebView 外壳放入 `android/`：Leanback 启动入口、横屏、沉浸式显示、本地 `WebViewAssetLoader`、D-Pad 焦点样式、禁止外部网页顶层跳转。
- 在 LibreTV 源码层移除“下载本集”、顶部下载管理入口、全局下载队列、M3U8 离线下载器及下载队列 IndexedDB 表。
- 保留源列表/设置配置导入导出、M3U 导出等数据管理能力；它们不是视频离线下载功能。
- 添加 16:9 大屏 CSS 与焦点可视化。
- 将用户提供的 17 个 Apple CMS 点播地址和 3 个 M3U 直播地址整理为 `frontend/public/source-pack-20261103.json`。设置 → 源管理 → 数据源订阅 / 分享中增加手动导入入口；导入前保持空源，不会自动加载。
- `AndroidManifest.xml` 中不要求触屏，强制横屏并注册 Leanback Launcher。
- Android 构建增加资源完整性检查：没有真实 Next 静态资源时，Gradle 会拒绝生成伪成品 APK。

## API 本地化状态与验证边界

LibreTV 主线是 Next.js 15 + React 19，原版 `src/app/api/` 含 18 组 Route Handler。工程已有 `android-tv-api.ts` 本地 API 分发、`MainActivity.java` 原生网络桥和媒体拦截路径；它们用于 APK 内处理接口逻辑，外部 CMS/M3U/EPG/CDN 仍由设备直接访问。当前属于**代码已接入、待真实构建和设备回归**，静态签名检查不等于全部接口与播放路径已验证。

本工程**没有添加默认点播源或直播源**。随包源集合只是可选资源文件，必须由用户在设置中手动导入；首次启动仍保持空源。

请查看：

- `docs/API_PORTING_MATRIX.md`：18 组接口的本地化职责和功能验证边界。
- `docs/SOURCE_PACK_IMPORT.md`：17+3 源集合的格式和手动导入规则。
- `docs/BUILD_STATUS.md`：构建自动化与验证状态。
- `docs/GITHUB_ACTIONS_BUILD.md`：GitHub Actions 和本地一键构建说明。
- `docs/LibreTV-AndroidTV-Build-Guide.md`：用户提供的构建指南。
- `docs/LibreTV-AndroidTV-Packaging-Spec.md`：用户提供的封装技术方案。

## 构建环境

完整构建需要 Node.js 22、JDK 17、Android SDK Platform 35、Build Tools 35.0.0、Android Gradle Plugin 8.7.3 和 Gradle Wrapper 8.9。通过 `bash tools/build-apk.sh` 完成从前端静态导出到 APK 校验的全流程。详细操作见 `docs/GITHUB_ACTIONS_BUILD.md`。

## License

LibreTV 上游项目声明使用 AGPL-3.0-or-later。发布修改版或二进制分发时，请遵守上游许可证及第三方依赖的许可证义务。详见 `frontend/LICENSE` 与 `android/THIRD_PARTY_NOTICES.md`。


## GitHub 一键构建 APK

已补齐 `.github/workflows/build-android-tv.yml`、Gradle Wrapper 8.9 启动脚本、官方 Wrapper JAR SHA-256 引导下载，以及完整的 APK 自动构建/验证脚本。

将完整工程（包括隐藏目录 `.github/`）上传至 GitHub 后，推送到 `main` / `master`，或从 **Actions → Build LibreTV Android TV APK → Run workflow** 手动运行。成功后从 Actions Artifact 下载 `LibreTV-TV-debug-<commit>`，内含 `LibreTV-TV-debug.apk` 和 SHA-256 文件。

本地完整构建：

```bash
bash tools/build-apk.sh
```

此命令需要 Node.js 22、JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。它会先执行 npm 安装、类型检查、单元测试和 Next.js 静态导出，再执行 Gradle 编译、APK Manifest/资源/ZIP/签名检查。**只有所有检查成功后才创建 `dist/LibreTV-TV-debug.apk`；任何阶段失败都会清理旧 APK 和 dist 目录，避免伪成品。**

详细操作见 `docs/GITHUB_ACTIONS_BUILD.md`。注意：本次交付仅完成工作流和构建自动化配置，制作环境无外网和 Android SDK，尚未实际运行 GitHub Actions 或生成 APK。