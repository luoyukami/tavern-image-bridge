# 酒馆生图 · CLIProxyAPI

一个无需构建、无需酒馆助手的 SillyTavern 前端扩展。右侧悬浮按钮打开控制面板，把所选楼层之前的最近聊天与预设拼接，调用 CLIProxyAPI 生图，再保存到酒馆并作为图片附件插入该楼层。保留原文和原有图片。

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

安装无需 `npm install`，也无需修改酒馆服务端或开启服务器插件。建议使用当前稳定版酒馆；代码包含旧版 `extra.image` 与新版 `extra.media` 两种附件处理方式，最低版本声明为 1.12.0，但未逐一实测所有历史版本。

## 界面预览

以下是模拟聊天环境中的扩展界面，截图中的 `8765` 端口仅用于本地测试；实际使用请填写自己的 CLIProxyAPI 地址。

![桌面控制面板](docs/desktop-preview.png)

<details><summary>手机界面</summary>

![手机控制面板](docs/mobile-preview.png)

</details>

## 首次使用

1. 打开一个有聊天内容的会话，点击右侧悬浮按钮。
2. 填写 **API 地址**，例如 `http://127.0.0.1:8317/v1`。也可填服务根地址或完整的 `/v1/images/generations` 地址。自定义反代前缀请保留，例如 `https://example.com/proxy/v1`。
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

API 请求直接由浏览器发往你配置的 CLIProxyAPI，所选聊天和预设会发给该服务。扩展不包含遥测，也没有其他第三方脚本或运行时依赖。

密钥默认只存在当前页面内存，刷新后需重新填写。勾选“记住密钥”后，会以明文存入酒馆扩展设置，可能随酒馆设置备份或导出；取消勾选会清除持久化副本。返回的远程图片 URL 下载时不会携带 API Key 或 Cookie；推荐使用 CLIProxyAPI 默认的 Base64 返回，减少图片地址跨域问题。

常见问题：

| 现象 | 检查事项 |
| --- | --- |
| 无法连接 / Failed to fetch | 代理是否启动、端口、CORS、浏览器混合内容限制。CLIProxyAPI 需允许酒馆页面的来源及 `Authorization`/`Content-Type` 请求头。 |
| 手机连接不上本机地址 | 手机上的 `127.0.0.1` 指手机。使用手机能访问到的代理主机局域网地址或 HTTPS 域名；代理也需监听对应网络接口。 |
| HTTPS 酒馆无法访问 HTTP 代理 | 为代理配置 HTTPS，或通过同源 HTTPS 反向代理访问；不要靠关闭浏览器安全设置解决。 |
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

14 项 Node 测试覆盖接口路径、模型名、上下文截取、预设替换、图片解析、错误处理、密钥隔离、消息身份校验、保存重试、旧版附件与取消。另已在独立 Chromium 浏览器中验证模型读取、模拟生图回填、PNG 渲染、密钥记忆开关、上传失败重试、聊天切换保护、手动重插和取消。

未连接你的实际 SillyTavern 实例或 CLIProxyAPI 账户。因此真实上游出图、你的代理 CORS 和实际酒馆版本的兼容性，需安装后用真实配置完成一次联调。

文件：`index.js` 为悬浮界面；`core.js` 为请求与上下文处理；`service.js` 为酒馆图片存储和附件写入；`style.css` 为隔离样式；`tests/` 和 `dev/` 为可选开发文件，不参与扩展运行。

## 许可证

本项目采用 [MIT License](LICENSE)。
