# LibreTV Android TV 模块

本目录是整合版工程的 Android 模块，依赖仓库根目录的 `frontend/`、`tools/` 和 `docs/`。

## Android 配置

- Package：`com.libretv.tv`
- App label：`LibreTV TV`
- 最低 SDK：21
- Compile SDK：35
- AGP：8.7.3
- Gradle Wrapper：8.9
- JDK：17
- 横屏锁定、Leanback Launcher、无触屏要求
- WebView 从 APK assets 加载本地站点；网络通过 APK 内桥接访问用户配置的外部源

## 构建

在仓库根目录运行完整构建：

```bash
bash tools/build-apk.sh
```

它会先构建 Next.js 静态资源，再调用本目录的 Gradle Wrapper 构建 debug APK，执行 APK/Manifest/资源/签名验证。仅当全部通过后才生成 `dist/LibreTV-TV-debug.apk`。

Gradle Wrapper JAR 由 `tools/bootstrap-gradle-wrapper.sh` 从 Gradle 官方发行站下载，并对照固定 SHA-256 校验；wrapper distribution 也配置了 SHA-256。JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0 为必需项。

也可用 Android Studio 打开本 `android/` 模块；首次运行 `./gradlew` 时会先引导下载并验证 Wrapper JAR。

## 不产出伪 APK

`app/build.gradle` 的 `preBuild` 会检查真实 `index.html`、Next JS/CSS chunks、源集合 JSON 和非占位页面。没有有效前端资源时 Gradle 直接失败。详细说明见 `../docs/GITHUB_ACTIONS_BUILD.md`。
