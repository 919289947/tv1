# GitHub Actions 自动构建 Android TV APK

## 工作流文件

仓库已添加：`.github/workflows/build-android-tv.yml`

以下情况会触发构建：

- 推送到 `main` / `master`
- 针对 `main` / `master` 的 Pull Request
- 推送 `v*` 标签
- 在 GitHub Actions 页面手动执行 `Build LibreTV Android TV APK`

## 构建环境

| 组件 | 固定版本/要求 |
|---|---|
| Node.js | 22 |
| JDK | Eclipse Temurin 17 |
| Android SDK Platform | 35 |
| Android Build Tools | 35.0.0 |
| Android Gradle Plugin | 8.7.3 |
| Gradle Wrapper | 8.9 |
| 前端 | 使用 `frontend/package-lock.json` 执行 `npm ci` |

AGP 8.7 对 Gradle 的最低版本要求为 8.9。Wrapper 的发行包和 Wrapper JAR 均使用 SHA-256 固定校验。

## Wrapper JAR 引导

`android/gradlew` 与 `android/gradlew.bat` 已加入工程。由于制作工程的环境不能访问外部网络，官方二进制 `gradle-wrapper.jar` 不随本次 ZIP 预置；`tools/bootstrap-gradle-wrapper.sh`（Windows 对应 `tools/bootstrap-gradle-wrapper.ps1`）会从 Gradle 官方发行站下载 Gradle 8.9 Wrapper JAR，并与 `android/gradle/wrapper/gradle-wrapper.jar.sha256` 中固定的官方 SHA-256 比较。校验失败会立即退出，不执行 Gradle。

GitHub Actions 在 `gradle/actions/setup-gradle@v6` 之前执行该引导脚本；该 Action 还会对 Wrapper JAR 进行完整性检查。Gradle 8.9 distribution 的 SHA-256 也固定在 `gradle-wrapper.properties` 中。

## 自动构建流程

工作流调用仓库根目录的：

```bash
bash tools/build-apk.sh
```

内部顺序：

1. 删除上次构建的 `dist/`、APK 输出目录和旧前端 assets，避免失败时误用旧文件。
2. 运行 `tools/check-api-coverage.py` 静态检查本地 API bridge 的关键签名。
3. 在 `frontend/` 执行 `npm ci`、`npm run typecheck` 和 `npm test`。
4. 临时移出 Next.js Route Handler 目录，构建 `ANDROID_TV_BUILD=1` 静态导出；退出时自动恢复 API 源码目录。
5. 检查导出目录确实包含 `index.html`、Next.js JS/CSS chunks、以及可手动导入的 17+3 数据源包。
6. 将静态资源复制到 `android/app/src/main/assets/`。
7. 检查 Android SDK Platform 35、Build Tools 35.0.0 和 JDK。
8. 下载并校验 Gradle Wrapper JAR，运行 `:app:clean :app:assembleDebug`。
9. 检查 APK ZIP CRC、包名、DEX、完整网页资源、TV Leanback 清单、横屏声明、源包 JSON，并通过 `apksigner verify`。
10. **仅全部成功后**才将 APK 复制为 `dist/LibreTV-TV-debug.apk` 并生成 SHA-256 文件。

## 防止伪 APK 的措施

- Gradle 的 `preBuild` 强制执行 `verifyLibreTvAssets`；缺少 `index.html`、Next JS/CSS 或源包文件时构建失败。
- 静态资源缺失、仍是占位页、引用 chunk 不存在时，前端构建脚本失败并清除资源目录。
- 全流程开始时删除旧 APK 和 `dist/`；任何阶段返回非零，清理函数都会删除 APK 输出与 `dist/`。
- APK 结构/Manifest/签名校验全部通过前，不复制到 `dist/`。
- GitHub Actions 只在 `success()` 时上传明确路径的已校验 APK；失败时没有 APK 上传步骤。
- 上传步骤使用 `if-no-files-found: error`，不会把“没有文件”误报为成功。

## 如何使用

1. 将本目录完整内容上传到自己的 GitHub 仓库，保留 `.github/workflows/` 隐藏目录。
2. 确保默认分支为 `main` 或 `master`，然后推送一次提交；也可以在 Actions 页面手动运行工作流。
3. 打开仓库的 **Actions → Build LibreTV Android TV APK**，等待任务完成。
4. 只有绿色成功任务会出现 `LibreTV-AndroidTV-debug-<commit>` Artifact。下载 ZIP 后解压即可得到 `LibreTV-TV-debug.apk` 和 SHA-256 文件。

此工作流生成的是可侧载安装的 **debug APK**，不是 Play 商店签名的 release APK。

## 重要边界

- 工作流尚未在用户 GitHub 仓库实际执行；本制作环境无外网下载、Android SDK、Gradle 和 ADB，因此本次只完成配置与静态校验，不宣称已成功编译 APK。
- API 静态签名覆盖检查不是外部采集源、播放、HLS、直播 EPG 的运行测试。真实电视设备仍须进行遥控器和媒体回归测试。
- 无自建服务端不等于离线播放；CMS、M3U、EPG 和 CDN 仍由用户设备直接访问外部站点。
