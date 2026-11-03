# 2026-11-03 源集合导入说明

## 文件

- 前端静态资源：`frontend/public/source-pack-20261103.json`
- 源集合名称：LibreTV 可用点播源合集
- 点播源：17 个 Apple CMS API
- 直播源：3 个 IPTV M3U 地址
- 测试日期、延迟及状态：来自用户在本次对话中提供的数据；本构建环境没有对上游地址重新测速。

## 与 LibreTV 原生格式的映射

用户提供的数据字段为 `vod_sources` / `live_sources`；LibreTV 的源列表解析器接受 `sources` / `liveSources`。随包文件采用 LibreTV 原生格式：

- `sources[]`：`name`、`url`、`type`、`response_time_ms`、`status`、`note`
- `liveSources[]`：`name`、`url`、`type`、`response_time_ms`、`status`、`note`

LibreTV 当前源配置模型保留并显示源名称和地址；`type`、`response_time_ms`、`status`、`note` 作为包内说明元数据保留，不改变原版列表显示组件。

## 导入方式

设置 → 源管理 → 数据源订阅 / 分享 → **导入源集合**。

此操作是明确的手动操作：

- 安装后首次启动时点播源和直播源仍为空。
- 不会自动选择、启用或加载这些地址。
- 用户按下导入按钮后才添加源。
- 点播源与直播源按地址去重，已存在的条目跳过。
- 新加入的普通点播源遵循原版 `addCustomApi` 状态逻辑；直播源遵循原版 `addLiveSubscription` 状态逻辑。

## 重要说明

源列表中的 `available` / `partial`、响应时间、测试地点及统计来自用户提供的记录，不代表本次打包时再次验证。源站可用性、地区限制、CORS/证书、码率和内容授权状态可能变化。HTTP 源本身也没有传输加密；在公共网络上使用时应自行评估风险。
