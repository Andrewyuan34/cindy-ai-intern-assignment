# Part 0(b) 每日单词卡需求分析

## 生成例句这一步要用到模型。这个插件应该怎么用上模型？ 请在仓库里找到依据并写出来

我会尝试复用 Cindy 的统一模型通道，使用 oneshot_text（快问快答）生成例句。这里的输入是当天 10 个单词和用户提供的工作场景，输出是对应例句；生成本身不需要读取文件、联网检索或执行多步工具操作，适合单次文本请求，无需为此创建 Agent 任务。

接入方式是在 ghost.json 中声明 "cindy": { "text": ["oneshot"] }，再通过 cindy.send 发送 type 为 "cindy-request"、kind 为 "oneshot_text" 的消息。prompt 写明单词列表、工作场景、例句要求和输出结构；由 Agent 的 tool-call 触发时，附带该调用的 callId 用于归因。cindy.text.oneshot 是能力名称，不能把它写成 cindy.text.oneshot() 方法。

实现思路是一次请求生成 10 个单词的例句，使用 expectJson: true 便于解析；插件再检查条目数、单词对应关系、字段和例句是否完整。宿主只保证 JSON 可解析，不替插件验证业务结构。当天结果按日期、单词列表和场景版本保存，避免每次打开重复生成；失败时明确展示原因，保留已有结果，不无限重试。

依据是：[plugin-runtime.md §4.0.2](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-runtime.md#L248) 这部分给出了声明、请求协议及边界；[cindySlot.ts 的 handleOneshotText](https://github.com/makecindy/cindy/blob/4ac45b894ef89459681367ec1330839a93243d1e/apps/desktop/src/main/cindy-brain/cindySlot.ts#L1500) 里有实际检查能力声明、请求参数和 JSON，并返回文本或结构化错误。

## 用户需要为这个插件额外配置什么吗？为什么？

如果 Cindy 已有可用的宿主模型通道，用户不需要为这个插件再填写一份 API Key，也不必重新配置模型接口地址。插件默认沿用宿主的模型选择机制；用户如有需要，可在插件详情的“模型与任务”中选择模型。

当前实现的选择优先级是：用户为插件选定的模型 → manifest 中可解析的 oneshotModel 偏好 → 系统辅助模型链。我会默认跟随宿主，不强制绑定某个供应商。用户明确选定的模型调用失败时，宿主不会静默换到其他模型。

但“无需重复配置”有前提：宿主必须存在可用的路由和凭据。若没有候选，调用会返回 NO_CANDIDATE，应引导用户在 Cindy 中配置或修复模型连接。

另外，为了让例句贴近用户工作，插件可能需要用户提供或确认职业、典型工作场景等业务信息，英语水平和偏好可以选填。因为oneshot_text 并不会自动读取用户的文件或聊天记录。

## 有同学的方案是“在插件设置页加一个输入框，让用户填自己的 OpenAI API Key，插件直接调接口”。你怎么看？

不认同把这个方案作为该插件的接入方式。

仓库规则明确要求模型调用走 Cindy 统一通道，不允许插件自建绕过通道的推理请求。即使插件具备一般联网能力，也不能据此把直接调用模型当作符合项目约定的设计。

而且这个方案会让用户重复处理凭据和供应商配置，把原本通用的单词卡绑定到 OpenAI，并让插件自行承担模型接口适配、错误处理和凭据管理。它也无法直接复用用户已经在 Cindy 中选择的其他可用模型通道，增加了使用门槛和维护负担。

可行的方案是让插件负责单词、场景、提示词、结果校验与展示，由 Cindy 负责模型路由和调用。用户如果希望使用 OpenAI，也通过 Cindy 支持的供应商配置接入；插件不另收、不保存、更不把模型 API Key 放进提示词。
