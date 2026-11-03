# LibreTV Android TV 构建指南 (Build Guide)

## 1. 环境准备
在开始构建之前，请确保你的开发环境已安装以下工具：
- **Android Studio**: 建议使用最新稳定版本 (Ladybug 或更高)。
- **JDK 17**: Android Gradle Plugin 8.x 的要求。
- **Android SDK**: 安装 API Level 31 (Android 12) 及以上。
- **Git**: 用于克隆项目。

## 2. 项目创建步骤
1. **创建新项目**: 
   - 打开 Android Studio $\rightarrow$ New Project $\rightarrow$ **No Activity**.
   - Name: `LibreTV TV`
   - Package name: `com.libretv.tv`
   - Minimum SDK: `API 21: Android 5.0 (Lollipop)` (确保兼容绝大多数 TV 盒子)。
2. **配置文件覆盖**: 
   - 将 `AndroidManifest.xml` 替换为技术方案中的内容。
   - 将 `build.gradle` (Module: app) 的依赖项更新为方案中的内容。
3. **主界面实现 (MainActivity)**:
   - 创建 `MainActivity.java` 或 `.kt`。
   - 在 `onCreate` 中设置全屏 `WebView`：
     ```java
     WebView webView = new WebView(this);
     webView.getSettings().setJavaScriptEnabled(true);
     webView.getSettings().setDomStorageEnabled(true);
     webView.setWebViewClient(new WebViewClient() {
         @Override
         public void onPageFinished(WebView view, String url) {
             // 注入剔除下载功能的 JS 脚本 (详见技术方案第 5 节)
             view.loadUrl("javascript:(function() { ... })()");
         }
     });
     setContentView(webView);
     webView.loadUrl("https://your-libretv-frontend-url.com"); 
     ```

## 3. 关键适配核对清单 (Checklist)
- [ ] **横屏锁定**: `AndroidManifest.xml` 中 `screenOrientation="landscape"`。
- [ ] **TV 启动项**: `category.LEANBACK_LAUNCHER` 已添加，确保在 TV 主界面可见。
- [ ] **触摸禁用**: `android.hardware.touchscreen` 设置为 `false`。
- [ ] **焦点导航**: 确认 WebView 能够通过遥控器方向键在链接和按钮间跳转。
- [ ] **功能过滤**: 确认下载按钮已被 JS 脚本移除，且 `download://` 链接被拦截。

## 4. 构建与打包
1. 点击 `Build` $\rightarrow$ `Build Bundle(s) / APK(s)` $\rightarrow$ `Build APK(s)`。
2. 构建完成后，在 `app/build/outputs/apk/debug/` 目录下获取 `app-debug.apk`。
3. 使用 `adb install app-debug.apk` 安装至电视端进行测试。
