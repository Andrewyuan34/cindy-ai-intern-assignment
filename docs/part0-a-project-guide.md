# Part 0(a) 项目导览

## 它由哪几个主要部分组成，各自负责什么

桌面端（apps/desktop）：Electron 应用。main 负责宿主业务、Agent 接线和插件运行；renderer 负责界面展示和用户交互；preload 提供 IPC 桥接。

移动端（apps/mobile）：Expo / React Native 客户端，通过设备互联访问执行端的任务和能力，并复用共享协议、鉴权和模型目录。

Agent 核心（packages/maker-core）：统一 Agent 抽象、任务会话和事件流，接入 Claude Code、Codex、Pi。该包不依赖 Electron，平台能力通过宿主注入。

共享能力（packages/*）：model-providers 管理模型目录和路由；device-link 负责跨设备通信；maker-shared、auth-client 提供共享契约和鉴权客户端。

插件与工具层：Desktop 的 main/cindy-brain 管理插件运行；packages/cindy-tools 提供 ghost_list、ghost_info、ghost_manual、ghost_call，供 Agent 发现、了解和调用插件。

以上模块可从[仓库地图](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/docs/dev-rules/repo-map.md)进入，再核对各模块源码和 package.json。

## 插件能用到 Cindy 提供的哪些能力（例如存储、联网、调用 Agent 等）——请写出你是在仓库里哪个文件或文档找到的依据

插件通过 ghost.json 声明贡献项和能力，由宿主检查权限并执行相应操作。需要区分“Agent 调用插件工具”和“插件请求宿主能力”两个方向。

存储：/kv 保存按插件隔离的 JSON 配置；cindy.fs(...) 操作允许范围内的文件；cindy.library(...) 管理持久作品。不同存储具有不同的卸载保留语义。依据：[plugin-settings.md](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-settings.md#L58)、[plugin-files-and-library.md](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-files-and-library.md)。

联网与凭据托管：cindy.fetch(...) 由宿主代发请求。自主联网需要声明目标域名；Agent 在途调用通过有效 callId 关联授权。托管凭据由宿主注入请求，不直接返回给沙箱。依据：[networkSlot.ts](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/src/main/cindy-brain/networkSlot.ts#L1123)。

简单文本生成：manifest 声明 cindy.text: ["oneshot"]，通过 cindy.send 发送 type 为 "cindy-request"、kind 为 "oneshot_text" 的请求。它使用宿主统一模型通道，不创建带工具的 Agent 任务。依据：[cindySlot.ts 的 handleOneshotText](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/src/main/cindy-brain/cindySlot.ts#L1500)。

Agent 交接：cindy.agent.run(...) 支持继续、新建或分叉任务。用户点击和后台唤起有不同授权条件，宿主核验点击票和任务关联。依据：[agentSlot.ts](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/src/main/cindy-brain/agentSlot.ts#L170)。

工具与界面：插件声明 tools 后接收 tool-call，并以 tool-result 返回结果；也可以提供聊天卡片或插件面板，展示和操作结构化内容。依据：[plugin-runtime.md](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-runtime.md)、[plugin-panels.md](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-panels.md)

## 你是怎么读的：先看了什么、后看了什么、用 AI 做了哪些事

使用 AI 辅助克隆仓库、检索文件、梳理架构并起草导览。之后去人手动阅读 AGENTS.md、README 和仓库地图，建立大概的模块边界，之后根据查阅到的参考信息检查架构入口与插件作者手册，最后人进行结果的审核。
