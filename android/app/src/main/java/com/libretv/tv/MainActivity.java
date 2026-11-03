package com.libretv.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.FilterInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;
import android.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Android TV shell + APK-local network/API bridge. No remote LibreTV backend is used. */
public final class MainActivity extends Activity {
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = APP_ORIGIN + "/index.html";
    private static final int MAX_API_BODY = 24 * 1024 * 1024;
    private static final int MAX_PLAYLIST_BODY = 4 * 1024 * 1024;

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private final ExecutorService nativeNetworkExecutor = Executors.newFixedThreadPool(8);

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureImmersiveLandscapeWindow();

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(8, 11, 18));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.requestFocus(View.FOCUS_DOWN);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setDefaultTextEncodingName("UTF-8");
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        webView.addJavascriptInterface(new NativeNetworkBridge(), "LibreTVNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                WebResourceResponse local = assetLoader.shouldInterceptRequest(uri);
                if (local != null) return local;
                if (isAppApiUrl(uri) && request.getMethod().equalsIgnoreCase("GET")) {
                    String path = uri.getPath() == null ? "" : uri.getPath();
                    if (path.startsWith("/api/proxy") || path.startsWith("/api/live/stream")) {
                        return interceptMediaRequest(request, path.startsWith("/api/live/stream"));
                    }
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return shouldBlockNavigation(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith(APP_ORIGIN + "/")) injectTvAndNoDownloadLayer();
            }
        });

        webView.setWebChromeClient(new WebChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                Toast.makeText(this, "此电视版不提供视频下载功能", Toast.LENGTH_SHORT).show());

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(8, 11, 18));
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (savedInstanceState == null) webView.loadUrl(START_URL);
        else webView.restoreState(savedInstanceState);
    }

    private boolean isAppApiUrl(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost());
    }

    /** Stream proxy: forwards Range/Referer and rewrites HLS child URIs back through this APK. */
    private WebResourceResponse interceptMediaRequest(WebResourceRequest request, boolean live) {
        HttpURLConnection connection = null;
        try {
            Uri uri = request.getUrl();
            String target = uri.getQueryParameter("url");
            if (target == null || target.isEmpty()) {
                String path = uri.getPath() == null ? "" : uri.getPath();
                String prefix = live ? "/api/live/stream/" : "/api/proxy/";
                if (path.startsWith(prefix)) target = Uri.decode(path.substring(prefix.length()));
            }
            if (!isHttpUrl(target)) return errorResponse(400, "Bad Request", "无效的媒体地址");

            URL targetUrl = new URL(target);
            connection = (HttpURLConnection) targetUrl.openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(30000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 Chrome/120 Safari/537.36 LibreTV-TV/2.21.1");
            String accept = request.getRequestHeaders().get("Accept");
            connection.setRequestProperty("Accept", accept == null ? "*/*" : accept);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Referer", targetUrl.getProtocol() + "://" + targetUrl.getAuthority() + "/");
            String range = request.getRequestHeaders().get("Range");
            if (range != null) connection.setRequestProperty("Range", range);

            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (input == null) input = new ByteArrayInputStream(new byte[0]);
            String contentType = connection.getContentType();
            if (contentType == null || contentType.isEmpty()) contentType = guessMimeType(target);

            boolean isM3u8 = contentType.toLowerCase(Locale.ROOT).contains("mpegurl")
                    || target.toLowerCase(Locale.ROOT).matches(".*\\.m3u8?(?:[?#].*)?$");
            if (isM3u8 && status >= 200 && status < 300) {
                byte[] data = readLimited(input, MAX_PLAYLIST_BODY);
                String playlist = new String(decompressIfGzip(data, connection.getContentEncoding()), StandardCharsets.UTF_8);
                String rewritten = rewritePlaylist(playlist, connection.getURL().toString(), live);
                Map<String, String> headers = responseHeaders(connection);
                headers.remove("Content-Length");
                headers.put("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
                headers.put("Cache-Control", "no-store");
                headers.put("Access-Control-Allow-Origin", "*");
                connection.disconnect();
                return new WebResourceResponse("application/vnd.apple.mpegurl", "UTF-8", status,
                        reasonPhrase(status), headers, new ByteArrayInputStream(rewritten.getBytes(StandardCharsets.UTF_8)));
            }

            Map<String, String> headers = responseHeaders(connection);
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-store");
            String mime = contentType.split(";")[0].trim();
            String encoding = parseCharset(contentType);
            final HttpURLConnection activeConnection = connection;
            InputStream managed = new FilterInputStream(input) {
                @Override public void close() throws IOException {
                    try { super.close(); } finally { activeConnection.disconnect(); }
                }
            };
            return new WebResourceResponse(mime, encoding, status, reasonPhrase(status), headers, managed);
        } catch (Exception e) {
            if (connection != null) connection.disconnect();
            return errorResponse(502, "Bad Gateway", e.getMessage() == null ? "媒体代理请求失败" : e.getMessage());
        }
    }

    private String rewritePlaylist(String content, String baseUrl, boolean live) {
        String prefix = live ? "/api/live/stream?url=" : "/api/proxy?url=";
        StringBuilder out = new StringBuilder(content.length() + 256);
        String[] lines = content.split("\\r?\\n", -1);
        Pattern uriAttr = Pattern.compile("URI=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);
        for (String line : lines) {
            String updated = line;
            Matcher matcher = uriAttr.matcher(updated);
            StringBuffer buffer = new StringBuffer();
            while (matcher.find()) {
                String absolute = resolveHttpUrl(baseUrl, matcher.group(1));
                if (absolute != null) matcher.appendReplacement(buffer, Matcher.quoteReplacement("URI=\"" + APP_ORIGIN + prefix + encodeQuery(absolute) + "\""));
            }
            if (buffer.length() > 0) {
                matcher.appendTail(buffer);
                updated = buffer.toString();
            }
            String trimmed = updated.trim();
            if (!trimmed.isEmpty() && !trimmed.startsWith("#")) {
                String absolute = resolveHttpUrl(baseUrl, trimmed);
                if (absolute != null) updated = APP_ORIGIN + prefix + encodeQuery(absolute);
            }
            out.append(updated).append('\n');
        }
        return out.toString();
    }

    private String resolveHttpUrl(String base, String raw) {
        try {
            URL result = new URL(new URL(base), raw.trim());
            String scheme = result.getProtocol().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            return result.toString();
        } catch (Exception ignored) { return null; }
    }

    private String encodeQuery(String value) {
        try { return URLEncoder.encode(value, "UTF-8"); }
        catch (Exception ignored) { return value; }
    }

    private byte[] decompressIfGzip(byte[] data, String contentEncoding) throws IOException {
        boolean gzip = (contentEncoding != null && contentEncoding.toLowerCase(Locale.ROOT).contains("gzip"))
                || (data.length > 2 && (data[0] & 0xff) == 0x1f && (data[1] & 0xff) == 0x8b);
        if (!gzip) return data;
        try (GZIPInputStream gzipInput = new GZIPInputStream(new ByteArrayInputStream(data))) {
            return readLimited(gzipInput, MAX_PLAYLIST_BODY * 8);
        }
    }

    /** Read at most maxBytes and close the source. Used for upstreams that ignore Range. */
    private byte[] readPrefix(InputStream input, int maxBytes) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int n;
            while (total < maxBytes && (n = in.read(buffer, 0, Math.min(buffer.length, maxBytes - total))) != -1) {
                out.write(buffer, 0, n);
                total += n;
            }
            return out.toByteArray();
        }
    }

    private byte[] readLimited(InputStream input, int limit) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int n;
            while ((n = in.read(buffer)) != -1) {
                total += n;
                if (total > limit) throw new IOException("响应内容超过大小限制");
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private Map<String, String> responseHeaders(HttpURLConnection conn) {
        Map<String, String> result = new HashMap<>();
        for (Map.Entry<String, java.util.List<String>> entry : conn.getHeaderFields().entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null || entry.getValue().isEmpty()) continue;
            String key = entry.getKey();
            if (key.equalsIgnoreCase("Transfer-Encoding") || key.equalsIgnoreCase("Content-Encoding")) continue;
            result.put(key, entry.getValue().get(0));
        }
        return result;
    }

    private String parseCharset(String contentType) {
        Matcher m = Pattern.compile("charset=([^;]+)", Pattern.CASE_INSENSITIVE).matcher(contentType);
        if (m.find()) return m.group(1).replace("\"", "").trim();
        return "UTF-8";
    }

    private String guessMimeType(String target) {
        String lower = target.toLowerCase(Locale.ROOT);
        if (lower.contains(".m3u8")) return "application/vnd.apple.mpegurl";
        if (lower.contains(".ts")) return "video/mp2t";
        if (lower.contains(".m4s") || lower.contains(".mp4")) return "video/mp4";
        if (lower.contains(".key")) return "application/octet-stream";
        if (lower.contains(".jpg") || lower.contains(".jpeg")) return "image/jpeg";
        if (lower.contains(".png")) return "image/png";
        if (lower.contains(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    private WebResourceResponse errorResponse(int code, String reason, String message) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "text/plain; charset=utf-8");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, headers,
                new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }

    private String reasonPhrase(int code) {
        switch (code) {
            case 200: return "OK"; case 206: return "Partial Content"; case 301: return "Moved Permanently";
            case 302: return "Found"; case 304: return "Not Modified"; case 400: return "Bad Request";
            case 403: return "Forbidden"; case 404: return "Not Found"; case 416: return "Range Not Satisfiable";
            case 429: return "Too Many Requests"; case 500: return "Internal Server Error"; case 502: return "Bad Gateway";
            case 503: return "Service Unavailable"; default: return "Response";
        }
    }

    private boolean isHttpUrl(String value) {
        if (value == null || value.length() > 8192) return false;
        try { URL u = new URL(value); return "http".equalsIgnoreCase(u.getProtocol()) || "https".equalsIgnoreCase(u.getProtocol()); }
        catch (Exception ignored) { return false; }
    }

    /** Local network bridge invoked from WebView JavaScript. */
    private final class NativeNetworkBridge {
        /**
         * Asynchronous bridge: keep WebView JavaScript responsive while multiple CMS sources
         * are queried concurrently. The callback is delivered on the WebView/UI thread.
         */
        @JavascriptInterface
        public void requestAsync(String address, String method, String headersJson, String body, int timeoutMs, int callbackId) {
            nativeNetworkExecutor.execute(() -> {
                String raw = request(address, method, headersJson, body, timeoutMs);
                WebView target = webView;
                if (target == null) return;
                final String quoted = JSONObject.quote(raw);
                target.post(() -> {
                    if (webView == target) {
                        target.evaluateJavascript("window.__LibreTVNativeResolve && window.__LibreTVNativeResolve(" + callbackId + "," + quoted + ");", null);
                    }
                });
            });
        }

        private String request(String address, String method, String headersJson, String body, int timeoutMs) {
            HttpURLConnection connection = null;
            JSONObject result = new JSONObject();
            try {
                if (!isHttpUrl(address)) throw new IOException("仅允许 HTTP/HTTPS 网络地址");
                URL url = new URL(address);
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(Math.max(1500, Math.min(timeoutMs, 60000)));
                connection.setReadTimeout(Math.max(1500, Math.min(timeoutMs, 60000)));
                connection.setRequestMethod(method == null ? "GET" : method.toUpperCase(Locale.ROOT));
                connection.setRequestProperty("Accept-Encoding", "gzip");
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 Chrome/120 Safari/537.36 LibreTV-TV/2.21.1");
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject headers = new JSONObject(headersJson);
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String key = it.next();
                        String value = headers.optString(key, "");
                        if (key.equalsIgnoreCase("Host") || key.equalsIgnoreCase("Content-Length") || key.equalsIgnoreCase("Connection")) continue;
                        connection.setRequestProperty(key, value);
                    }
                }
                String verb = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
                if ((verb.equals("POST") || verb.equals("PUT") || verb.equals("PATCH")) && body != null && !body.isEmpty()) {
                    connection.setDoOutput(true);
                    if (connection.getRequestProperty("Content-Type") == null) connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    if (payload.length > MAX_API_BODY) throw new IOException("请求内容过大");
                    try (OutputStream out = connection.getOutputStream()) { out.write(payload); }
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (stream == null) stream = new ByteArrayInputStream(new byte[0]);
                String rangeHeader = headersJson == null ? "" : headersJson.toLowerCase(Locale.ROOT);
                int responseLimit = rangeHeader.contains("range") ? 128 * 1024 : MAX_API_BODY;
                byte[] bytes = rangeHeader.contains("range") ? readPrefix(stream, responseLimit) : readLimited(stream, responseLimit);
                if ((connection.getContentEncoding() != null && connection.getContentEncoding().toLowerCase(Locale.ROOT).contains("gzip"))
                        || (bytes.length > 2 && (bytes[0] & 0xff) == 0x1f && (bytes[1] & 0xff) == 0x8b)) {
                    bytes = decompressIfGzip(bytes, connection.getContentEncoding());
                }
                Charset charset = StandardCharsets.UTF_8;
                String ct = connection.getContentType();
                if (ct != null) {
                    Matcher m = Pattern.compile("charset=([^;]+)", Pattern.CASE_INSENSITIVE).matcher(ct);
                    if (m.find()) { try { charset = Charset.forName(m.group(1).replace("\"", "").trim()); } catch (Exception ignored) { } }
                }
                result.put("status", status);
                result.put("body", new String(bytes, charset));
                JSONObject responseHeaders = new JSONObject();
                for (Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                    if (entry.getKey() == null || entry.getValue() == null || entry.getValue().isEmpty()) continue;
                    responseHeaders.put(entry.getKey().toLowerCase(Locale.ROOT), entry.getValue().get(0));
                }
                result.put("headers", responseHeaders);
            } catch (Exception e) {
                try { result.put("status", 502); result.put("error", e.getMessage() == null ? "网络请求失败" : e.getMessage()); }
                catch (JSONException ignored) { }
            } finally {
                if (connection != null) connection.disconnect();
            }
            return result.toString();
        }

        /** Binary range fetch used by the local quality probe; media is never buffered in full. */
        @JavascriptInterface
        public String requestBytes(String address, String headersJson, int timeoutMs, int maxBytes) {
            HttpURLConnection connection = null;
            JSONObject result = new JSONObject();
            try {
                if (!isHttpUrl(address)) throw new IOException("仅允许 HTTP/HTTPS 网络地址");
                URL url = new URL(address);
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(Math.max(1500, Math.min(timeoutMs, 30000)));
                connection.setReadTimeout(Math.max(1500, Math.min(timeoutMs, 30000)));
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept-Encoding", "identity");
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 Chrome/120 Safari/537.36 LibreTV-TV/2.21.1");
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject headers = new JSONObject(headersJson);
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String key = it.next();
                        String value = headers.optString(key, "");
                        if (key.equalsIgnoreCase("Host") || key.equalsIgnoreCase("Content-Length") || key.equalsIgnoreCase("Connection")) continue;
                        connection.setRequestProperty(key, value);
                    }
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (stream == null) stream = new ByteArrayInputStream(new byte[0]);
                byte[] bytes = readPrefix(stream, Math.max(1, Math.min(maxBytes, 256 * 1024)));
                result.put("status", status);
                result.put("url", connection.getURL().toString());
                result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                JSONObject responseHeaders = new JSONObject();
                for (Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                    if (entry.getKey() == null || entry.getValue() == null || entry.getValue().isEmpty()) continue;
                    responseHeaders.put(entry.getKey().toLowerCase(Locale.ROOT), entry.getValue().get(0));
                }
                result.put("headers", responseHeaders);
            } catch (Exception e) {
                try { result.put("status", 502); result.put("error", e.getMessage() == null ? "二进制网络请求失败" : e.getMessage()); }
                catch (JSONException ignored) { }
            } finally {
                if (connection != null) connection.disconnect();
            }
            return result.toString();
        }

        /** AES-128-CBC no-padding prefix decryption, matching the original Node crypto path. */
        @JavascriptInterface
        public String decryptAes128CbcPrefix(String cipherBase64, String keyBase64, String ivBase64) {
            try {
                byte[] encrypted = Base64.decode(cipherBase64, Base64.NO_WRAP);
                byte[] key = Base64.decode(keyBase64, Base64.NO_WRAP);
                byte[] iv = Base64.decode(ivBase64, Base64.NO_WRAP);
                int usable = (encrypted.length / 16) * 16;
                if (usable == 0 || key.length < 16 || iv.length < 16) return "";
                Cipher cipher = Cipher.getInstance("AES/CBC/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(java.util.Arrays.copyOf(key, 16), "AES"), new IvParameterSpec(java.util.Arrays.copyOf(iv, 16)));
                byte[] out = cipher.doFinal(encrypted, 0, usable);
                return Base64.encodeToString(out, Base64.NO_WRAP);
            } catch (Exception ignored) {
                return "";
            }
        }
    }

    private void configureImmersiveLandscapeWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(8, 11, 18));
        window.setNavigationBarColor(Color.rgb(8, 11, 18));
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveFlags();
    }

    private void applyImmersiveFlags() {
        final int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    private boolean shouldBlockNavigation(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("download".equals(scheme) || "intent".equals(scheme) || "file".equals(scheme)
                || "content".equals(scheme) || "javascript".equals(scheme)) return true;
        return !("https".equals(scheme) && "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost()));
    }

    private void injectTvAndNoDownloadLayer() {
        String js = "(function(){"
                + "document.documentElement.classList.add('tv-mode');"
                + "if(window.__libretvTvLayerInstalled)return;window.__libretvTvLayerInstalled=true;"
                + "var css=`html,body{min-height:100%;min-width:960px;}body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent;}"
                + "a,button,input,select,textarea,[role=button],[tabindex]:not([tabindex='-1']){outline:none;scroll-margin:32px;}"
                + ":focus,:focus-visible{outline:3px solid #57a6ff!important;outline-offset:4px!important;box-shadow:0 0 0 5px rgba(87,166,255,.22),0 0 22px rgba(87,166,255,.28)!important;z-index:20;}"
                + "button:focus,a:focus,[role=button]:focus{transform:scale(1.035);transition:transform .12s ease;}video{max-width:100%;}"
                + "@media(min-width:1100px){body{font-size:18px;}nav,aside,[data-tv-sidebar]{scrollbar-width:none;}}"
                + "a[download],.download-btn,#download-btn,[data-action*='download' i],[aria-label*='download' i],[title*='download' i],[aria-label*='下载'],[title*='下载'],button[class*='download' i],a[class*='download' i]{display:none!important;visibility:hidden!important;pointer-events:none!important;}`;"
                + "var style=document.createElement('style');style.id='libretv-tv-overrides';style.textContent=css;(document.head||document.documentElement).appendChild(style);"
                + "function removeDownloads(root){if(!root||!root.querySelectorAll)return;root.querySelectorAll(\"a[download],.download-btn,#download-btn,[data-action*='download' i],[aria-label*='download' i],[title*='download' i],[aria-label*='下载'],[title*='下载'],button[class*='download' i],a[class*='download' i]\").forEach(function(el){el.remove();});}"
                + "removeDownloads(document);new MutationObserver(function(records){records.forEach(function(r){r.addedNodes.forEach(function(n){if(n.nodeType===1)removeDownloads(n);});});}).observe(document.documentElement,{childList:true,subtree:true});"
                + "document.addEventListener('keydown',function(e){if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key)){var a=document.activeElement;if(a&&a.scrollIntoView&&a.getBoundingClientRect){var r=a.getBoundingClientRect();if(r.bottom<0||r.top>innerHeight)a.scrollIntoView({block:'nearest',inline:'nearest'});}}},true);"
                + "})();";
        webView.evaluateJavascript(js, null);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) { return super.dispatchKeyEvent(event); }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override protected void onResume() { super.onResume(); applyImmersiveFlags(); if (webView != null) webView.onResume(); }
    @Override protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }

    @Override protected void onDestroy() {
        nativeNetworkExecutor.shutdownNow();
        if (webView != null) { webView.stopLoading(); webView.removeAllViews(); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
