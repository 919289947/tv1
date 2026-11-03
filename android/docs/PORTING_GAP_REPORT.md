# LibreTV 2.21.1 → Android TV 本地 API 迁移清单

**目标约束：** 不部署远程自建服务端。所有 API 逻辑在 APK 内实现（建议 WebView JS + Android 原生网络桥接，或等价的 APK 内本地实现）；外部采集站、节目单和媒体 CDN 仍是数据来源，不属于自建服务端。

上游 API 源码：`frontend/src/app/api/**/route.ts`；前端调用封装：`frontend/src/lib/client-api.ts`。

| 路由 | 上游职责 | Android TV 本地实现要求 | 当前状态 |
|---|---|---|---|
| `GET /api/status` | 版本、鉴权状态、环境预置源 | 返回本地版本；三个预置列表必须为空；不启用密码登录门控 | 未迁移 |
| `GET/POST/DELETE /api/auth` | 服务端密码会话 | 本地模式需移除服务端密码流程并保持本机可用；不能假装有安全的远程会话 | 未迁移 |
| `POST /api/search` | 多采集站聚合搜索、分页、去重、过滤、排序、超时、流式结果 | 原生网络桥接请求各用户配置 CMS 源；复用 `cms-parser.ts`、过滤和排序规则；处理并发与超时 | 未迁移 |
| `GET /api/detail` | CMS 详情解析、特殊详情页 HTML 兜底 | 原生网络桥接取详情；复用 `parseDetail` / `parseDetailPageHtml` | 未迁移 |
| `POST /api/source/test` | 点播源连通性测试 | 本地请求用户填写的源，保留原版结果结构 | 未迁移 |
| `GET /api/source-list` | 读取 LibreTV SourceList / TVBox 订阅 | 原生网络桥接获取订阅 JSON，复用现有解析与限额 | 未迁移 |
| `POST /api/publish` | 发布源列表到第三方粘贴服务 | 原生网络桥接执行固定第三方 POST；不得演化成任意 URL 转发 | 未迁移 |
| `GET /api/live/playlist` | 下载并解析 M3U、缓存、去重 | 本地网络请求 + `m3u-parser.ts`，保留原字段与筛选行为 | 未迁移 |
| `GET /api/live/epg` | XMLTV 节目单解析及缓存 | 本地取 XMLTV 并复用 `xmltv.ts`；注意大文件与时区解析 | 未迁移 |
| `POST /api/live/probe` | 批量直播测活、分片级探测、流式反馈 | Android 网络桥接探测 playlist/segment；保留超时、codec、kbps 等结果字段 | 未迁移 |
| `GET /api/live/stream` 与 `/api/live/stream/[url]` | 直播流转发 | 原生请求拦截器处理重定向、Range、Content-Type；HLS 子清单相对 URI 必须可继续解析 | 未迁移 |
| `GET /api/proxy` 与 `/api/proxy/[url]` | 通用媒体/图片代理 | WebView 原生资源拦截实现；重定向、Range、Referer 和跨域头需兼容播放器 | 未迁移 |
| `POST /api/quality` | 批量清晰度探测 | 本地网络桥接探测 m3u8、fMP4/TS 分片；复用 `quality-probe.ts` 中可移植逻辑 | 未迁移 |
| `GET /api/douban` | 豆瓣推荐数据 | 原生桥接或可直连的官方/上游 API；保留分类、分页、字段结构 | 未迁移 |
| `GET /api/bangumi/calendar` | Bangumi 每日放送 | 原生桥接请求与解析；保留原推荐卡片数据形状 | 未迁移 |
| `GET /api/hot-list` | 热榜聚合 | 原生桥接请求；按原版 list ID 与响应结构处理 | 未迁移 |

> 上表列出源码中找到的 18 个 Route Handler（将直播流与通用代理的新旧路径分别计数）。

## 关键实现约束

1. **源列表不能被替换成另一个简化界面。** 保留 `source-manager.tsx`、`live-source-manager.tsx`、订阅同步、禁用/启用、探活状态和源显示顺序等原版逻辑。
2. **绝不注入默认源。** TV 本地状态初始化必须是空列表；不在 APK assets、环境变量或默认常量中写入点播/直播地址。
3. **不要只依赖 CSS 隐藏服务端 API。** 所有 `/api/*` 需要真正有本地实现，尤其是 `/api/proxy` 和 `/api/live/stream`；否则“搜得到但无法播放”或“页面能开但频道列表空”都不是完整移植。
4. **原生网络层需要支持：** GET/POST、请求头、Referer、User-Agent、超时、重定向、Range、二进制流和取消请求。不能把视频分片先全部读入内存。
5. **安全策略要区分用途。** 上游 `ssrf.ts` 是服务端防 SSRF 的重要保护。移至本地设备后仍应限制协议为 HTTP(S)，并明确是否允许用户主动添加的局域网 IPTV 地址；不能把任意 URL 代理暴露给外部网络。
6. **直播/点播共用 WebView 时要验证 DRM/编码能力。** Android 系统 WebView、设备硬件解码和播放器 HLS.js/MPEG-TS 路径因厂商而异，必须用真实电视盒子验证。
7. **接口流式事件需要保留。** 搜索与测活目前存在 NDJSON 流式反馈。若本地桥接改为一次性 JSON，虽然最终列表可能显示，但原版逐源即时反馈会丢失，不算完全一致。
8. **发布订阅是第三方网络操作。** 它不是视频下载，首轮源代码修改保留该功能；需要检查第三方服务可访问性和许可证/隐私策略。

## 完成判定

- 所有本表接口具有本地实现，不再请求 APK 中不存在的 `/api/*` Next 服务端路由。
- 所有原版前端页面能从 APK assets 启动，且主要交互不出现 404。
- 点播搜索/详情/播放、直播订阅/M3U/EPG/频道播放、历史续播、设置、换源、质量提示均通过回归测试。
- 下载管理入口、下载本集、离线分片下载队列及下载写盘逻辑均不存在；普通源/设置数据导出仍可保留。
- 默认点播源、默认直播源、默认订阅数均为 0。
