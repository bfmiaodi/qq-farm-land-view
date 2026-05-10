# QQ Farm WSS Monitor

基于 `mitmproxy + Node.js` 的 QQ 农场实时监听与可视化工具。

当前能力：

- 监听 QQ 农场 WSS 二进制帧
- 解码土地、好友农场、好友摘要等协议
- 网页实时查看我的土地和好友土地
- 导出 PNG 截图，方便发给好友
- 保存原始帧、解码 JSON、中文解码 JSON
- 支持作物图片展示，本地资源优先，缺图自动兜底

## 目录结构

- [src/index.js](/Users/hqh/Desktop/03-study/scripts/src/index.js)
  协议解码、作物/种子配置读取
- [src/reqable-log-server.js](/Users/hqh/Desktop/03-study/scripts/src/reqable-log-server.js)
  本地 HTTP 服务、实时网页、PNG 截图导出
- [src/mitmproxy-qqfarm-addon.py](/Users/hqh/Desktop/03-study/scripts/src/mitmproxy-qqfarm-addon.py)
  `mitmproxy` 插件，转发目标 WSS 帧到本地服务
- [game-config](/Users/hqh/Desktop/03-study/scripts/game-config)
  作物、物品、本地图片资源
- [logs/frames](/Users/hqh/Desktop/03-study/scripts/logs/frames)
  抓到的原始帧、解码文件

## 安装

```bash
cd /Users/hqh/Desktop/03-study/scripts
npm install
```

需要额外准备：

- `mitmproxy`

例如：

```bash
pip install mitmproxy
```

## 启动

先启动本地服务：

```bash
cd /Users/hqh/Desktop/03-study/scripts
node src/reqable-log-server.js
```

再启动 `mitmdump`：

```bash
cd /Users/hqh/Desktop/03-study/scripts
mitmdump --mode socks5 -p 8080 --ssl-insecure --set connection_strategy=lazy -s src/mitmproxy-qqfarm-addon.py
```

如果你的客户端不是 `SOCKS5`，而是普通 `HTTP/HTTPS` 代理，则不要用 `--mode socks5`。

## 客户端代理

当前这套抓包在你的环境里是按 `SOCKS5` 跑通的：

- 代理类型：`SOCKS5`
- 地址：`127.0.0.1`
- 端口：`8080`

并且客户端需要信任 `mitmproxy` 根证书，否则 HTTPS/WSS 握手会失败。

## 访问地址

服务启动后可访问：

- 首页监控页  
  [http://127.0.0.1:18088/](http://127.0.0.1:18088/)

- 运行态 JSON  
  [http://127.0.0.1:18088/api/state](http://127.0.0.1:18088/api/state)

- 健康检查  
  [http://127.0.0.1:18088/healthz](http://127.0.0.1:18088/healthz)

- 我的农场 PNG 截图  
  [http://127.0.0.1:18088/share/farm.png](http://127.0.0.1:18088/share/farm.png)

- 当前访问好友农场 PNG 截图  
  [http://127.0.0.1:18088/share/friend.png](http://127.0.0.1:18088/share/friend.png)

## 当前支持的协议

当前已经接入并实时聚合：

- `gamepb.plantpb.PlantService.AllLands`
- `gamepb.visitpb.VisitService.Enter`
- `gamepb.friendpb.FriendService.GetAll`
- `gamepb.friendpb.FriendService.SyncAll`
- `gamepb.friendpb.FriendService.GetGameFriends`
- `gamepb.itempb.ItemService.Bag`

说明：

- 首页已移除“背包/种子”主展示区，但背包数据仍支持解析
- 土地页面重点展示“我的农场”和“当前访问好友”

## 网页展示

首页现在是卡片网格展示，不再是表格：

- 我的农场：每行 4 个地块卡片
- 当前访问好友：每行 4 个地块卡片
- 好友摘要：列表展示

每个土地卡片默认展示：

- 作物图片
- 地块号
- 作物名
- 状态 / 阶段
- 成熟时间
- 变异标签
- 变异中文结果

网页里当前不展示这些次要信息：

- 种子 ID
- 产量倍率
- 变异 ID
- 果实数
- 等级明细

## PNG 截图

截图使用服务端渲染，不依赖浏览器。

当前截图特性：

- 每行 4 个地块卡片
- 和网页尽量保持同样的展示逻辑
- 支持好友信息头部
- 背景色按真实变异 ID 高亮

截图适合直接保存后发给好友。

## 变异映射

当前项目里，小号 `mutantConfigId` 已确认映射有：

- `1 -> 冰冻`
- `3 -> 暗化`
- `4 -> 湿润`
- `5 -> 黄金`
- `6 -> 稀世`

另外还兼容部分大号资源 ID：

- `1040025 -> 冰冻`
- `1040046 -> 爱心`
- `1040109 -> 火焰`
- `1040112 -> 黄金`
- `1040121 -> 黄金`
- `1040224 -> 幽灵`
- `1040249 -> 稀世`

说明：

- 真实显示优先看协议里的 `mutantConfigId`
- 背景高亮也只跟真实变异 ID 走
- 如果有真实变异 ID，但当前没映射，会显示 `未知变异(xxx)`

## 抓包文件输出

抓到的目标帧会保存到：

- [logs/frames](/Users/hqh/Desktop/03-study/scripts/logs/frames)

按日期分目录，例如：

```text
logs/frames/20260510/
```

同一帧通常会生成：

- `*.bin`
- `*.json`
- `*.cn.json`

其中：

- `*.bin` 原始 protobuf 二进制
- `*.json` 解码摘要
- `*.cn.json` 中文字段解释版

## 资源与图片

当前网页卡片图片逻辑：

1. 优先使用本地 `game-config/seed_images_named`
2. 若缺图，则显示文字占位

本地资源目录：

- [game-config/seed_images_named](/Users/hqh/Desktop/03-study/scripts/game-config/seed_images_named)

项目里已经同步过：

- [qq-farm-automation-main/core/src/gameConfig/Plant.json](/Users/hqh/Desktop/03-study/scripts/qq-farm-automation-main/core/src/gameConfig/Plant.json)
- [qq-farm-automation-main/core/src/gameConfig/ItemInfo.json](/Users/hqh/Desktop/03-study/scripts/qq-farm-automation-main/core/src/gameConfig/ItemInfo.json)

并覆盖到当前：

- [game-config/Plant.json](/Users/hqh/Desktop/03-study/scripts/game-config/Plant.json)
- [game-config/ItemInfo.json](/Users/hqh/Desktop/03-study/scripts/game-config/ItemInfo.json)

说明：

- 新 JSON 已同步
- 但 `qq-farm-automation-main` 里没有一套新的种子图片目录
- 所以图片资源目前仍依赖你本地现有 `seed_images_named`

## 关于 CDN 资源

你已经抓到过类似：

- `https://cdn-resource.nqf.qq.com/release/remote/plant/native/.../*.astc`
- `https://cdn-resource.nqf.qq.com/release/remote/petdog/import/.../*.json`

说明确实存在资源 CDN，但当前还没有拿到完整 manifest 规则。

注意：

- `astc` 不是浏览器可直接显示的图片格式
- 想批量下载全部资源，通常要先抓到资源清单 `manifest/catalog`
- 当前网页展示仍建议优先走本地 PNG

## 常见问题

### 1. 为什么网页没数据

通常是以下原因之一：

- 还没抓到 `gate-obt.nqf.qq.com/prod/ws`
- `mitmdump` 没正常加载 addon
- 客户端代理模式不对
- 客户端没信任 `mitmproxy` 证书

先看：

- [http://127.0.0.1:18088/api/state](http://127.0.0.1:18088/api/state)

如果还是全空，说明目标帧还没入库。

### 2. 为什么会看到 `Client closed connection before completing request headers: b'\\x05\\x01\\x00'`

这通常说明客户端在用 `SOCKS5`，但 `mitmdump` 没按 `SOCKS5` 模式启动。

### 3. 为什么会看到“已变异”但下面是“无”

之前是变异中文映射表不完整导致的。  
现在如果还有这种情况，说明出现了新的 `mutantConfigId`，需要继续补映射。

### 4. 为什么部分作物没图片

因为本地还没有对应图片资源。  
当前已做文字占位兜底，不会空白。

## 开发建议

如果你后面继续扩这套工具，优先顺序建议是：

1. 给图片补一个 `seed_images_override` 覆盖目录
2. 继续补齐小号 `mutantConfigId` 映射
3. 抓资源 manifest，研究 CDN 批量下载
4. 如果确实需要，把截图页做成更完整的海报风格

