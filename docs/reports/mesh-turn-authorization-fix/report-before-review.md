# Mesh 完成 followUp 可信续接修复：有界交付报告

## 结论与限制

已在两个源码仓库实现、未提交、未发布、未安装。开始时两个仓库 `git status --short` 均为空；没有覆盖既有用户修改，没有改动安装的 node_modules 或游戏仓库。

**修复的是缺失的跨插件授权续接链，不是删除拦截或更换报错。** 为避免从自然语言/子节点输出推断不确定授权范围，采用严格最小范围：真实用户回合的初始 `mesh run` 预声明 `continuationTasks`，成功通知只允许一次针对原 run 的 `mesh continue`，创建该固定计划。不是所有 Mesh action 放行。

**现有未预声明计划的 run，以及完成后才出现的任意修复任务，仍须新的真实用户授权。** 本补丁不让原报告中的历史 run 自动获得新权限；需要加载新版并在真实用户回合重新规划。工作流/Direct 通知暂不接入此机制。失败、重试、恢复/新 epoch、race 取消等不生成续接许可。

## 根因与读取范围

读取原报告 `/Users/relvf/pocket/stellar-game-server/docs/reports/mesh-turn-authorization-20260918/index.html` 及 E01–E05 原文：Cross `tool_call` 只认 user 且未取消；Mesh `watchBackground → CompletionNotifier → sendMessage(followUp, triggerTurn)` 没有携带可信授权来源。新逻辑回合落到 unknown，敏感建任务入口被正常拦截。

源码核对链路：Mesh run 创建、Manager epoch/attempt/取消锁、异步完成与通知分组；Cross input/agent_start/message_start/message_end/agent_settled/abort/会话注册关闭及 tool_call；Direct 生命周期取消锁保持原状。核对 Pi 扩展文档的 EventBus、sendMessage、signal、生命周期和工具事件，以及 SDK `sendCustomMessage` 保留 details 对象身份的实现。无 GitNexus 工具，使用源码 grep/sed 替代，未修改项目索引。

## 实现与安全边界

- Cross 仅在真实用户授权的原始 `mesh run` tool_call 记录准确参数、toolCallId、Host session/cwd。
- Mesh 在 create 之前经现有 EventBus 申请进程内能力；缺少/旧版 Cross、来源不符或预算不足直接失败，不创建原 run。
- Mesh 绑定真实 run ID/原 epoch，保存不可由后续工具参数改变的任务快照；模型在原计划准入时解析。
- 只有原 epoch 全部节点首尝试成功、无 run/node 取消来源或锁，才在 notifier 实际 flush 时关联 SDK details 对象；只有成功关联才输出续接指引。
- Cross 用 WeakMap 中的**对象身份**认领真实消息，不以正文、customType、JSON token、历史记录提权。消息分组可保留多个独立 run 的许可。
- 新 provenance 为受限 `mesh`，绝不改为 `user`。仅放行 `{action:"continue",runId}`；多余参数、其他 run、任意新 run、resume/retry/recover/growth/bridge/Direct/config 都不因此获准。
- 门控先消费一次许可，再由 Mesh execute 按同一 toolCallId 认领；失败不退款，重放不获准，claim 不能跨 settled 回合。
- 每真实用户代际最多 16 个许可，每许可一次后续 run；签发后 1 小时到期；每计划 1–4 个固定 agent/task，顺序执行、并发 1、每任务最多 10 分钟、零重试、无递归续接、无 cwd/worktree/setup/policy 参数覆盖。
- abort/不安全结算、新 interactive/RPC 输入、session_start/replacement、reload/shutdown 撤销。会话/根目录不匹配拒绝。能力不持久化、不经 IPC 暴露。
- 不清 Direct/Mesh 的取消锁，不重开 Cross peer 接收，不修改 Manager 的恢复和取消判定。
- 信任边界仍是同进程可信扩展/同 OS 用户；不是 arbitrary Bash 或恶意同进程扩展沙箱。SDK 若不再保留 live details 对象身份，会拒绝续接，不降级到可伪造文本令牌。

## 修改文件与 diff

Mesh：`src/continuation.ts`、`src/extension.ts`、`src/notifications.ts`、`test/unit/continuation.test.ts`、`test/integration/mesh-host.test.ts`、`test/bridge/run.mjs`、`README.md`。

Cross：`lib/mesh-continuation.ts`、`extensions/cross-session.ts`、`test/mesh-continuation.test.mjs`、`README.md`。

完整补丁（包括新增源码/测试，不含本报告证据目录自身）：
- [mesh.patch](mesh-turn-authorization-fix/mesh.patch)
- [cross.patch](mesh-turn-authorization-fix/cross.patch)

## 实际测试，不混淆各轮源码

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 最终 Mesh 短定向：continuation、notifications、mesh-host | **15/15 PASS** | `mesh-final-focused.log` |
| 最终 Cross 新增安全回归 | **16/16 PASS** | `cross-final-focused.log` |
| 最终真实 SDK 双插件/真实 Managed 子 Agent 链路 | **5/5 PASS** | `sdk-final.log` |
| 最终 Mesh `npm run test:types` | exit 0 | `mesh-types.log` |
| 最终 Cross `npm run typecheck` | exit 0 | `cross-types.log` |
| 较早 Mesh 定向，含 Direct/Mesh lifecycle 取消锁 | **100/100 PASS** | `mesh-earlier-100.log` |
| 较早 Cross 全套 guarded test | **73/73 PASS** | `cross-earlier-73.log` |

用户要求限时收尾后，没有再次跑两仓全量套件。较早 100/73 通过后，最终补充了 claim 跨 settled 的撤销保护、缺失 claim ID 防护、仅在实际授予时显示通知指引及相应小测试；最终短定向/类型/SDK 均对最后源码重跑通过。不把较早全量冒称最终全量。

最终 SDK 使用 Mesh 的统一 0.83.0 SDK 家族、真实 Host AgentSession、真实 Mesh Manager/Managed AgentSession 与 Cross 源码，只替换 provider 为确定性本地响应，禁用外部网络。五例为：idle 完成后续建、busy 排队 followUp 后续建、取消、新用户输入、伪造 custom 通知。正例原 run+固定后续 run 共两个真实子 Agent；反例只有原子 Agent；所有场景随后尝试任意新 run 均被 Cross 拦截。正例再调用 continue 拒绝重放。

Cross 新测试另覆盖 JSON 克隆/伪 customType、peer 正文/peer preflight、unknown/extension 输入、过期、session_start/shutdown/不同 session/root、签发预算、分组、错误 run/额外参数、claim 在取消/过期/settled 后失效。session 切换撤销的新专项是受控生命周期测试，不冒称新增了完整 UI session-switch 端到端测试；较早 Cross 全套含真实 SDK 0.84.4 reload/管理上下文回归。

### 保留的失败/环境限制

1. Cross 首次全套：71 PASS/1 FAIL，新增过期测试取了签发前的时钟基准，模拟时间可能尚未到真实签发后的 TTL。修正测试为在签发后取基准，再前移一小时；产品 TTL 未变。原失败日志保留 `cross-first-run-test-failure.log`。
2. 直接运行原有跨仓 bridge harness，被其既有“Host 与 Mesh 必须使用同一 SDK 包身份”断言阻断：安装树有相同 0.83.0 的两个不同 pi-ai 路径。未改安装树；临时目录复制源码/测试并软链到已有统一 SDK 家族后，最终 5 例真实运行通过。说明见 `initial-sdk-barrier.txt`，实际依赖路径/版本/Cross SHA 在 `sdk-final.log` 的 BRIDGE_SOURCES。
3. 未跑完整 Mesh npm test、完整 bridge 历史套件、线上模型/部署或游戏项目测试。这些不属于本轮最终有界验证的 PASS 声明。

最终短定向命令：

```sh
# Mesh 仓库
node --import ./test/support/clean-env.mjs --experimental-strip-types --test --test-concurrency=1 test/unit/continuation.test.ts test/unit/notifications.test.ts test/integration/mesh-host.test.ts
npm run test:types
# Cross 仓库（隔离环境，Node 22.23.1）
bash test/run-clean.sh node --test --test-concurrency=1 test/mesh-continuation.test.mjs
npm run typecheck
# 临时统一 SDK 的 Mesh 源码副本（Node 24.14.1）
node --import ./test/support/clean-env.mjs --experimental-strip-types --test-name-pattern='continuation actual SDK' test/bridge/run.mjs --cross-source /Users/relvf/ai/pi-cross-session
```

## 生效方式

需要**同时加载这两个修改后的源码扩展**。若当前加载的是源码仓库：等活动任务结束后 `/reload`；若当前加载的是 npm 安装版本：仅 reload 不会应用本仓库修改，需用户切换到两个本地源码扩展或自行更新安装后 reload，避免同时加载重复版本。本次没有执行安装、发布或 reload，也没有改 installed node_modules。

所有旧许可在 reload/会话重建时失效；之后由真实用户重新发起带固定 continuationTasks 的原始 run。尚未确定的后续任务应询问用户，不自动扩大范围。
