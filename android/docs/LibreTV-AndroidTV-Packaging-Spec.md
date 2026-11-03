# LibreTV Android TV 封装技术方案

## 1. 项目概述
本项目旨在将 LibreTV 的前端能力封装为原生的 Android TV APK。采用「无服务端」方案，即 APK 本身作为一个 WebView 壳，直接加载 LibreTV 的前端页面，通过 Android 原生配置实现 TV 端适配。

## 2. 核心封装策略 (参考 LibreTV-App)
- **框架选择**: 采用 Android WebView + Android TV Leanback 适配。
- **无服务端实现**: 将 LibreTV 的静态资源（HTML/JS/CSS）直接打包进 APK 的 `assets` 目录，或者配置一个固定的前端入口 URL。
- **TV 端适配**: 
  - 强制横屏显示 (`landscape`)。
  - 禁用触摸输入，优化 D-Pad (遥控器) 焦点导航。
  - 移除所有与「下载」相关的 UI 元素和 JS 逻辑。

## 3. 关键配置文件

### 3.1 AndroidManifest.xml
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.libretv.tv">

    <!-- 声明为 TV 应用 -->
    <uses-feature android:name="android.software.leanback" android:required="true" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:banner="@drawable/app_banner"
        android:label="LibreTV TV"
        android:logo="@drawable/app_logo"
        android:supportsRtl="true">
        
        <activity 
            android:name=".MainActivity"
            android:screenOrientation="landscape"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

### 3.2 build.gradle (App level)
```gradle
dependencies {
    implementation 'androidx.leanback:leanback:1.0.0'
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'androidx.webkit:webkit:1.7.0'
}
```

## 4. 布局与交互设计 (横屏方案)
- **视图结构**: 全屏 `WebView` 填充。
- **CSS 注入**: 在页面加载时注入特定的 TV 样式表，将原本的移动端布局转换为横屏宽屏布局：
  - 侧边栏导航固定在左侧。
  - 内容区域采用 Grid 布局，每行显示 4-6 个海报。
  - 增加焦点状态 (`:focus`) 的视觉增强（如外边框发光、缩放 1.1x）。

## 5. 功能过滤与源配置
- **剔除下载**: 
  - **UI 层面**: 通过 WebView 的 `onPageFinished` 回调注入 JS 脚本，利用 CSS 选择器精准移除下载按钮。
    ```javascript
    (function() {
      const style = document.createElement('style');
      style.innerHTML = '.download-btn, [class*="download"], [id*="download"] { display: none !important; }';
      document.head.appendChild(style);
      
      // 动态监控新生成的元素
      const observer = new MutationObserver(() => {
        document.querySelectorAll('.download-btn').forEach(el => el.remove());
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })();
    ```
  - **逻辑层面**: 拦截 WebView 的 `shouldOverrideUrlLoading`，屏蔽所有以 `download://` 或包含 `download` 关键字的 URL 请求。
- **源显示**: 
  - 保持 LibreTV 原有的动态配置机制。
  - 不预设任何默认源，由用户在设置界面输入，确保显示逻辑与原版完全一致。
