# 酒馆生图 · CLIProxyAPI

一个无需构建、无需酒馆助手的 SillyTavern 扩展。右侧悬浮按钮打开控制面板，把所选楼层之前的最近聊天与预设拼接，调用 CLIProxyAPI 生图，再保存到酒馆并作为图片附件插入该楼层。保留原文和原有图片。支持使用酒馆自带后台转发，无需浏览器直接访问生图服务。

**从 1.0 升级：**原有配置会保留“浏览器直连”，避免未经选择就把 `127.0.0.1` 的含义改到另一台机器。远程部署酒馆的用户，请按下方说明启用代理，并在面板中切换为“酒馆后台转发”。新安装默认使用后台转发。

## 安装

### 推荐：在酒馆中通过仓库安装

1. 打开酒馆顶部的“扩展”面板，选择“安装扩展”。
2. 粘贴以下仓库地址并安装：

   ```text
   https://github.com/luoyukami/tavern-image-bridge
   ```

3. 刷新页面，在扩展管理中确认“酒馆生图 · CLIProxyAPI”已启用。
4. 后续在酒馆的扩展管理中检查更新并更新此扩展，然后刷新页面。扩展同时启用了酒馆支持的 `auto_update` 标记；具体自动更新时机由酒馆版本决定。

### 手动安装

1. 解压安装包，找到 `tavern-image-bridge` 文件夹。
2. 将**整个文件夹**放到 SillyTavern 安装目录中的以下任一位置：
   - 当前用户：`data/<你的用户目录>/extensions/tavern-image-bridge/`，默认通常为 `data/default-user/extensions/tavern-image-bridge/`。
   - 所有用户：`public/scripts/extensions/third-party/tavern-image-bridge/`。
3. 确认 `manifest.json` 直接位于上述文件夹内，不要多套一层文件夹。
4. 刷新酒馆页面，在扩展管理中确认“酒馆生图 · CLIProxyAPI”已启用。右侧出现图片按钮；扩展设置中也有“打开酒馆生图”入口。

酒馆的“安装扩展”输入框需要 Git 仓库 URL，不能直接填 ZIP 路径。手动安装的文件副本不会变成 Git 仓库；需要便捷更新时，建议使用上面的仓库安装方式。GitHub 自动生成的源码 ZIP 文件夹可能带有分支名或版本号，手动安装时请将文件夹重命名为 `tavern-image-bridge`。

安装无需 `npm install`，也无需修改酒馆服务端代码或安装额外服务器插件。后台转发模式需要修改酒馆的配置并重启，见下文。建议使用当前稳定版酒馆；代码包含旧版 `extra.image` 与新版 `extra.media` 两种附件处理方式，最低版本声明为 1.12.0，但未逐一实测所有历史版本。

## 远程酒馆：让请求从酒馆服务器发出

### 配置一次即可

1. 在酒馆服务器上，编辑**实际使用的** `config.yaml`，通常位于酒馆根目录。Docker 部署时编辑映射到容器内的配置文件，不要修改 `default/config.yaml`。
2. 找到并修改这一项，避免重复添加同名配置：

   ```yaml
   enableCorsProxy: true
   ```

3. 重启酒馆进程或容器。
4. 更新扩展并刷新页面，将面板的“连接方式”设为 **酒馆后台转发（推荐）**。
5. API 地址填写**从酒馆服务器能访问的** CLIProxyAPI 地址，填好客户端 API Key，然后点击“读取模型”检查连接。

请求路径是：`当前设备的浏览器 → 同源酒馆 /proxy/ → CLIProxyAPI`。模型列表、生图请求和返回图片 URL 的下载都会走后台。浏览器只连接酒馆，不需要 CLIProxyAPI 配置浏览器 CORS，HTTPS 酒馆也不会因为上游使用 HTTP 而触发浏览器混合内容拦截。不要把酒馆网页地址当成 CLIProxyAPI 地址填写。

### 地址怎样填

| 部署方式 | API 地址示例与含义 |
| --- | --- |
| 酒馆与 CLIProxyAPI 在同一台服务器，均直接运行 | `http://127.0.0.1:8317/v1`；这里的 `127.0.0.1` 就是服务器 |
| 酒馆与 CLIProxyAPI 分别位于同一 Docker 网络的两个容器 | 例如 `http://cliproxyapi:8317/v1`，使用实际的 Docker 服务名；API 需监听容器可达的接口 |
| 酒馆在 Docker 内，CLIProxyAPI 在宿主机 | 使用容器能访问到的宿主机地址或网关；`127.0.0.1` 只指酒馆容器 |
| CLIProxyAPI 在另一台机器 | 使用酒馆服务器能够访问到的内网地址或域名 |

酒馆内置代理受酒馆自身访问控制和服务器出站网络设置影响。开启时请保留已有登录、IP/Host 白名单等保护；如启用了 `privateAddressWhitelist`，只把需要访问的 CLIProxyAPI 内网地址加入允许列表，不要为此关闭所有保护。配置与转发实现见 [酒馆配置文档](https://docs.sillytavern.app/administration/config-yaml/) 和 [原生代理源码](https://github.com/SillyTavern/SillyTavern/blob/release/src/middleware/corsProxy.js)。

**HTTP Basic Auth 限制：**酒馆原生 `/proxy/` 会转发 `Authorization` 给上游。若酒馆或其前置反代同时要求 HTTP Basic Auth，该请求头会与 CLIProxyAPI 的 Bearer Key 冲突。扩展会在收到 Basic 认证挑战时说明原因；这种部署需改用保留访问保护的同源定向反代、专门的服务端插件，或选择浏览器直连。本版不会关闭认证，也不会在后台模式失败后自动改走浏览器。

### 浏览器直连模式

当 API 本来就在当前设备上，或已提供可跨域访问的 HTTPS 地址时，可以主动选择“浏览器直连”。此时 `127.0.0.1` 指浏览器所在设备，需要 API 允许 CORS，并满足浏览器的 HTTPS/HTTP 限制。这是 1.0 版本的连接方式。

## 界面预览

以下是模拟聊天环境中的扩展界面，截图中的端口仅用于本地测试；实际使用请填写自己的 CLIProxyAPI 地址。

![桌面控制面板](docs/desktop-preview.png)

<details><summary>手机界面</summary>

![手机控制面板](docs/mobile-preview.png)

</details>

## 首次使用

1. 打开一个有聊天内容的会话，点击右侧悬浮按钮。
2. 选择 **连接方式**，然后填写 **API 地址**，例如 `http://127.0.0.1:8317/v1`。后台转发模式按酒馆服务器的网络环境填写；直连模式按当前设备填写。也可填服务根地址或完整的 `/v1/images/generations` 地址。自定义反代前缀请保留，例如 `https://example.com/proxy/v1`。
3. 填入 CLIProxyAPI 的**客户端 API Key**，不要填管理面板的管理密钥。
4. 图片模型默认是 `gpt-image-2.5`。可点击“读取模型”，再输入或选择代理支持的名称；也支持 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2` 或带提供商前缀的实际模型名。读取模型只调用 `/v1/models`，不会生图。
5. 设置“最近聊天层数”，编辑生图预设，然后点击“生成并插入楼层”。

默认读取最近 6 层有效聊天，图片插入最新有效楼层。下拉框也可选择最近 100 层中的某一层，此时聊天截取范围截至该层。界面中的“第 1 层”对应酒馆内部消息索引 0。

## 预设与上下文

预设只有一份，可直接修改，自动保存。支持三个占位符：

| 占位符 | 替换内容 |
| --- | --- |
| `{{chat}}` | 截至目标楼层的最近 N 层有效聊天，包含楼层号和说话人 |
| `{{char}}` | 当前角色名；群聊使用酒馆提供的当前名称 |
| `{{user}}` | 当前用户名 |

不包含 `{{chat}}` 时，聊天内容会自动追加到预设末尾。展开“预览发送内容”可检查完整请求文本。默认预设要求直接生成当前场景插画，不调用另一个文本模型来改写提示词。

“有效聊天”指非系统/非隐藏、且有文本的消息。会移除 HTML 标签、`think/thinking` 块、脚本样式块和图片 Markdown；不读取 `extra` 中的思维链、角色卡、世界书或历史图片。需要保持人物细节时，可把人物外貌写进预设。单次提示词超过 32000 字符时会提示减少层数，不会静默截断。

## 图片与悬浮控件

- 图片与悬浮设置中可选择方形、横向、纵向、自动尺寸以及质量。`xhigh/max` 需所选模型支持。
- 每次请求一张 PNG；同时兼容接口实际返回的 JPEG/WebP。
- 默认最长等待 600 秒，可调整为 30–1800 秒。
- 悬浮按钮可上下拖动，闲置约 2.2 秒后自动贴边，鼠标移入或触摸可展开；也可关闭自动隐藏。
- 点击外部、关闭按钮或 Esc 可收起面板，收起不会取消生图。点击“取消”会停止等待，但服务端是否停止生成由代理决定。
- 不自动监听每条回复生图，不自动重试失败的生图请求，避免意外重复调用。

## 保存与恢复

图片先通过酒馆原生 `/api/images/upload` 保存到酒馆用户图片目录，再记录到聊天消息附件中，最后调用 `saveChat()`。重新打开聊天时由酒馆自己的图片功能渲染。原文不会被图片或 HTML 替换。

生成请求绑定发起时的聊天、消息对象、正文和文本 swipe。等待期间增加新楼层不会改变目标；切换聊天、删除原楼层、编辑正文或切换该楼层的 swipe，会阻止自动插入。生成结果保留在面板内，可以下载，或点击“插入当前所选楼层”明确地转存到当前选择的楼层。

上传失败时点击“重试保存并插入”，只重试保存，不再次生图。聊天保存失败后再次保存也不会重复添加图片。可用“清除预览”放弃内存中的结果，以开始下一次生成；不会删除已经插入的图片或服务器文件。

**尚未保存的结果只保留在当前页面内存中**，刷新或禁用扩展会丢失，请先下载。图片已经上传但聊天保存失败时，服务器上的文件可能仍然存在。

## 密钥与连接

后台转发模式下，浏览器先请求同源酒馆，再由酒馆连接你配置的 CLIProxyAPI；直连模式下，浏览器直接连接 CLIProxyAPI。所选聊天和预设会发给该服务。扩展不包含遥测，也没有其他第三方脚本或运行时依赖。

密钥默认只存在当前页面内存，刷新后需重新填写。勾选“记住密钥”后，会以明文存入酒馆扩展设置，可能随酒馆设置备份或导出；取消勾选会清除持久化副本。后台转发时，Cookie 只用于访问酒馆，当前酒馆原生代理会移除 Cookie 与 CSRF 请求头后再向上游发请求。扩展只传递所需的 CSRF 请求头，不会把酒馆的其他自定义请求头复制给代理。下载返回的图片 URL 时不转发 API Key；后台模式会显式设置空 Bearer 头，避免浏览器缓存的 Basic 登录凭据被代理转发。

常见问题：

| 现象 | 检查事项 |
| --- | --- |
| 提示后台代理尚未启用 | 在实际生效的酒馆 `config.yaml` 中设置 `enableCorsProxy: true` 并重启。 |
| 后台模式无法连接 / 500 / 502 | 检查酒馆服务器到 CLIProxyAPI 的连接、容器网络、内网白名单、前置反代是否允许 `/proxy/` 路由，以及酒馆服务器日志。 |
| 直连模式无法连接 / Failed to fetch | 检查 API 是否运行、端口、CORS 和浏览器混合内容限制；推荐切换后台转发。 |
| 手机连接不上 127.0.0.1 | 先确认连接方式。直连时它指手机；后台时它指酒馆服务器或酒馆容器。 |
| HTTPS 酒馆与 HTTP API | 使用后台模式，浏览器只访问酒馆的 HTTPS；酒馆服务器再访问 HTTP API。 |
| HTTP Basic Auth 冲突 | 原生代理无法同时用同一个 Authorization 头完成酒馆 Basic 认证与上游 Bearer 认证，见上面的部署限制说明。 |
| 401 / 403 | 使用客户端 API Key，检查密钥及代理权限。 |
| 404 | 检查地址、CLIProxyAPI 版本、图片接口是否被禁用。当前源码配置 `multimedia.disable-image-generation: true` 会禁用图片接口；旧版本配置层级可能不同，以你的版本示例为准。 |
| 模型不支持 / 无图片 | 以你的 `/v1/models` 和该版本 CLIProxyAPI 支持情况为准；能列出模型不等于上游账户一定具备生图权限。 |
| 429 / 超时 | 检查额度、限速和代理日志。扩展不会自动重试；超时后代理仍可能完成生成。 |
| 生成成功但保存失败 | 保留预览，下载图片或点击重试保存；检查酒馆写入权限、反代上传大小限制及磁盘空间。 |

## 接口约定

```http
POST /v1/images/generations
Authorization: Bearer YOUR_CLIENT_KEY
Content-Type: application/json
```

```json
{
  "model": "gpt-image-2.5",
  "prompt": "预设与所选聊天拼接后的完整文本",
  "n": 1,
  "size": "1024x1024",
  "quality": "auto",
  "output_format": "png",
  "stream": false
}
```

解析 `data[0].b64_json`，也兼容 `data[0].url` 的图片 Data URL 或 HTTP/HTTPS 地址。未传 `response_format`，使用 CLIProxyAPI 的默认 Base64 行为。本扩展使用 Images 接口，不使用 `/v1/chat/completions`，无需自行配置 Codex 主线模型或 `image_generation` 工具调用。

核对资料（2026-09-27）：

- [CLIProxyAPI 图片路由与模型处理源码](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/api/handlers/openai/openai_images_handlers.go)
- [CLIProxyAPI 配置示例](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)
- [OpenAI 图片接口文档](https://developers.openai.com/api/docs/guides/image-generation)
- [SillyTavern 扩展开发文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern 上下文 API](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js)

## 开发与验证

无需安装依赖，使用 Node.js 20+：

```sh
npm test
npm run demo
```

模拟环境地址为 `http://127.0.0.1:8765`，模拟酒馆上下文、模型列表、生图响应和图片保存。只返回一张测试像素图，不连接外部服务。`PORT` 环境变量可修改端口。模拟环境中的设置与真实酒馆分开保存。

25 项 Node 测试覆盖接口路径、模型名、上下文截取、预设替换、图片解析、错误处理、密钥隔离、消息身份校验、保存重试、旧版附件与取消，以及后台路由、旧配置迁移、代理关闭、Basic Auth 冲突、图片 URL 转发、无自动回退和远程 HTTP 页面的图片 ID 生成。模拟环境提供仅允许本地测试端点的 `/proxy/` 路由；已在独立 Chromium 浏览器中验证模型读取、生图、图片 URL 下载、回填保存、代理关闭时的提示和手动切换直连。`/mock/control` 可设置 `proxyEnabled: false` 模拟未开启代理，或设置 `imageUrl: true` 模拟返回图片链接。

未连接你的实际 SillyTavern 实例或 CLIProxyAPI 账户。因此真实上游出图、服务器网络和实际酒馆版本的兼容性，需安装后用真实配置完成一次联调。

文件：`index.js` 为悬浮界面；`core.js` 为请求与上下文处理；`service.js` 为酒馆图片存储和附件写入；`style.css` 为隔离样式；`tests/` 和 `dev/` 为可选开发文件，不参与扩展运行。

## 许可证

本项目采用 [MIT License](LICENSE)。
