# Android TV 构建状态

## 已加入工程的自动化构建配置

- `.github/workflows/build-android-tv.yml`：GitHub Actions 自动构建工作流。
- `android/gradlew`、`android/gradlew.bat`：Gradle Wrapper 启动脚本。
- `android/gradle/wrapper/gradle-wrapper.properties`：固定 Gradle 8.9 和 distribution SHA-256。
- `android/gradle/wrapper/gradle-wrapper.jar.sha256`：固定官方 Wrapper JAR SHA-256。
- `tools/bootstrap-gradle-wrapper.sh` / `.ps1`：从 Gradle 官方发行站引导下载 Wrapper JAR 并校验。
- `tools/build-android-tv.sh`：前端依赖、静态 API 覆盖检查、测试、静态导出、assets 完整性检查。
- `tools/build-apk.sh`：完整前端 + Android APK 编译与校验入口。
- `tools/verify-web-assets.py`：检查 Next.js 导出资源。
- `tools/verify-apk.py`：检查 APK ZIP、包名、DEX、网页资源、TV Manifest 与空源/源包资产。

## 固定构建矩阵

| 组件 | 版本 |
|---|---|
| Node.js | 22 |
| JDK | 17 |
| Android SDK Platform | 35 |
| Android Build Tools | 35.0.0 |
| Android Gradle Plugin | 8.7.3 |
| Gradle | 8.9 |

AGP 8.7 的最低 Gradle 版本为 8.9。发行包与 Wrapper JAR 都固定 SHA-256。

## 防伪产物机制

1. 构建开始会清理旧 `dist/` 与旧 APK 输出。
2. 前端构建前检查 API 适配静态标记并运行覆盖检查、TypeScript 检查和单元测试。
3. Next 静态导出必须包含 index.html、Next JS/CSS chunks 和源包 JSON。
4. Gradle `preBuild` 强制验证资源，拒绝占位页或不完整前端。
5. APK 编译后需通过 ZIP CRC、包名、DEX、网页资源、Leanback、横屏以及 apksigner 验证。
6. 只有以上全部成功才复制到 `dist/`；任何失败都会清理 APK 输出和 `dist/`。
7. GitHub Actions 仅在 `success()` 时上传 `dist/LibreTV-TV-debug.apk`，失败不上传 APK。

## 当前实际验证

本制作环境中：

- 离线模拟构建（`npm_config_offline=true bash tools/build-apk.sh`）按预期因 npm 缓存缺少 zustand 依赖失败；已确认 `dist/`、`app-debug.apk` 和旧 assets 均被清理，API 源码目录正常恢复。此测试证明失败时不保留伪/过期 APK，不代表完整构建成功。

- `tools/check-api-coverage.py`：静态检查通过（20/20）。
- 脚本 Bash 语法、Python 脚本语法、workflow YAML 与 Gradle 配置静态检查需以本轮报告为准。
- 无法下载依赖和 Gradle Wrapper JAR（容器无外网 DNS/网络）。
- 无 Android SDK/Build Tools、无 ADB、无连接电视设备。

因此本轮没有编译出 APK，也没有在 GitHub Actions 真实运行。不能将配置完成描述为编译成功。

## 运行边界

API 本地代码仍标记为“已接入、待编译/功能回归”。静态签名覆盖不等于接口真实网络验证。真实 Android TV 上还需测试点播、直播、HLS、Range、重定向、EPG、遥控器导航和历史续播。源包只供用户手动导入，默认点播源/直播源初始化仍为空。
