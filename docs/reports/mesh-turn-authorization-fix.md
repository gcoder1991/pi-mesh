# Mesh 完成 followUp 可信续接修复：重新授权后的验证报告

## 当前结论

用户明确重新授权后，已修复独立审查指出的四项问题，并完成要求的**两仓全套测试、类型检查、两仓 diff 检查，以及新增真实 SDK 场景**。结果见下表，不以 Mesh 调度状态代替测试通过。

修改仅在 `/Users/relvf/ai/pi-mesh` 与 `/Users/relvf/ai/pi-cross-session` 源码工作树，**未提交、未安装、未发布、未 reload，没有修改任一已安装 node_modules**。测试使用隔离临时目录和已有依赖，没有调用线上模型。接手时两仓已有未提交成果；已保留而非覆盖还原。接手状态见 `revision-start-*-status.txt`。

前序报告完整保存在 [report-before-review.md](mesh-turn-authorization-fix/report-before-review.md)，旧补丁和 SHA 清单另存 `mesh-before-review.patch`、`cross-before-review.patch`、`sha256-before-review.json`，原有日志和失败证据均保留。下文的“当前结果”取代前序限时有界验证的结论。

## 四项修复与回归

### 1. 历史 peer 接收锁不再撤销新用户计划

Cross `agent_settled` 的当前回合安全判断不再包含 `!stopped`。`stopped` 仅代表历史取消留下的 **peer 接收锁**；当前回合仍必须有成功终态、未中止的 active signal、已知来源且 `!turnCancelled`。真正的取消/不安全结算依然调用 `latch()`，撤销许可。peer flush 仍单独要求 `!stopped`，没有清除历史锁，也没有执行 `/cross-session-resume`。

- 组件回归：旧用户计划 → abort → 旧许可失效 → 新 interactive 用户签发新计划 → 正常 settled → 新通知准入 → allow/claim 成功；前后状态均 `stopped=true`，真实 IPC peer 投递仍返回 `stopped`。
- 真实 SDK 回归：历史 Host abort → 新 interactive 用户实际 `mesh run` → 正常 settled → 完成通知实际创建固定后继；只有原任务和预声明后继两个 Managed Agent，任意新 run 被拒绝，peer 接收锁保持关闭。
- Direct/Mesh 自身取消锁和恢复判定没有改动。

### 2. SDK all 模式保留两条独立完成消息的许可

`MeshContinuations.message()` 不再在每条可信消息到达时无条件清空 active。仅将**新准入、有效、同 session/root** 的 grants 合并到当前 active；每个 details 仍从 WeakMap 一次性取走。无关、伪造、重放、scope 不符或不可准入的消息仍清空 active；settle、取消、新用户代际仍隔离，claim 的回合检查不变。

- 组件回归：独立 details、不同 parent 分别可且仅可 allow/claim 一次；随后插入不可信消息、取消或新用户输入时，两项均拒绝。
- **实际 `session.setFollowUpMode('all')` SDK 场景**：两次真实背景 run，Host 忙时两个 notifier 分别发送独立 details 的 followUp；确认两个对象不同、每条只有一个 ID、两条同时出现在下一次模型上下文中；两个不同 parent 分别成功创建其原定后继，两个重放和任意新 run 均返回 `isError=true`。精确断言总共四个真实 Managed Agent、四个 run，并核对持久化任务与 parent 对应，而非只断言工具被调用。

### 3. Mesh strict actions 契约更新

`test/unit/extension.test.ts` 的**完整枚举 deepEqual 保留**，在准确位置加入 `continue`。修复前实际重跑记录 **83 PASS / 1 FAIL**；修复后完整 unit **84/84 PASS**。没有删除断言、扩大成模糊包含检查或跳过测试。

### 4. different-session 不再是未 reserve 就 claim 的假回归

- 原 different-session 分支改为实际 `session_start` 重新绑定注册 Host，随后投递旧 details 并断言 `tool_call` 明确 block、claim 拒绝，不再提前 return。
- 增加 capability 本身的 scope 测试：不同 session 的消息准入 `message=false`；另一个有效同 session 通知先准入成功，再尝试不同 session 的 `allow=false/claim=false`，最后同 session 的 `allow=true/claim=true` 正控证明许可确实可用，且只能一次。
- 增加**先成功 reserve**，再注册 session replacement 后 claim 拒绝的测试，覆盖“已获准但尚未执行”的撤销链。

## 保持不变的授权边界

修复的仍是跨插件可信授权链，不是从子节点自然语言推断用户授权，也不是放开全部 Mesh actions。

- 真正用户初始 `mesh run` 预声明固定 `continuationTasks`。Cross 记录准确参数/toolCallId/Host session/cwd；Mesh create 前申请进程内能力，缺少/旧版 Cross 或预算不足则不创建原 run。
- Mesh 保存不可修改的计划快照、绑定原 run/epoch。仅原 epoch 全节点首尝试成功、无 run/node 取消来源或锁时，在 notifier 实际 flush 为 live details 对象关联能力。
- Cross 只认 WeakMap 中的对象身份，不认正文、customType、JSON 克隆、历史记录或序列化 token。来源是受限 `mesh`，绝不改为 `user`。
- 仅允许 `{action:"continue",runId}`。Host/session/root/run/epoch/用户代际绑定、单次消费/防重放、1 小时 TTL、每用户代际最多 16 个许可均保留。claim 必须匹配 gate 预留的 toolCallId，不能跨 settled；失败不退款。
- 后继仅 1–4 个预声明 agent/task，顺序、并发 1、每任务最多 10 分钟、零重试、无递归续接，无 cwd/worktree/setup/policy 覆盖。原 Manager 信任、预算和取消判定继续生效。
- abort、不安全结算、新 interactive/RPC 输入、session replacement、reload/shutdown 撤销。没有清 Direct/Mesh 取消锁，也没有重新开放 peer 接收。
- 不支持既有无预声明 run 自动获权；未知后续修复任务、workflow/Direct 通知、任意 run/resume/retry/recover/growth/bridge/config 仍需真实用户授权。

## 当前实际验证结果

所有测试项均无失败、无跳过；源代码在全量测试后没有再修改。

| 检查 | 实际结果 | 证据文件（本目录下证据子目录） |
|---|---|---|
| Mesh 完整 `npm test` | **exit 0**：unit **84/84**、integration **256/256**、e2e **25/25**，合计 **365/365**；types、package dry-run 均通过 | `revision-mesh-full.log` |
| Cross 完整 `npm test`（guarded wrapper） | **81/81 PASS，exit 0** | `revision-cross-full.log` |
| Cross 类型检查 | `tsc --noEmit` **exit 0** | `revision-cross-types.log` |
| Cross 最终续接专项 | **23/23 PASS，exit 0** | `revision-cross-focused-final.log` |
| 最终真实 SDK 双插件/Managed Agent 续接专项 | **7/7 PASS，exit 0** | `revision-sdk-final.log` |
| 两仓 `git diff --check` | **均 exit 0** | `revision-diff-check.log` |
| 两份完整源码补丁对各自 HEAD 的 `git apply --check` | **均 exit 0** | `revision-patch-check.log` |

SDK 七例：idle、busy、当前取消、新用户输入、伪造通知、**历史取消后新用户新计划**、**all 模式两独立消息/parent**。使用 Mesh 现有 **0.83.0 SDK 家族**的真实 Host AgentSession、Mesh Manager、Managed AgentSession 和 Cross 源码，provider 替换为确定性本地响应，网络被测试 guard 禁用。`BRIDGE_SOURCES` 记录实际依赖路径/版本与 Cross SHA；`MESH_SNAPSHOT` 记录测试快照与 Mesh 源码 SHA 一致。Cross 全套使用其现有 **0.84.4 SDK**、Node **22.23.1**；Mesh 全套和双插件 SDK 场景使用 Node **24.14.1**。

### 实际命令

```sh
cd /Users/relvf/ai/pi-mesh
npm test

cd /Users/relvf/ai/pi-cross-session
bash test/run-clean.sh test
bash test/run-clean.sh run typecheck
bash test/run-clean.sh node --test --test-concurrency=1 test/mesh-continuation.test.mjs

cd /Users/relvf/ai/pi-mesh
bash docs/reports/mesh-turn-authorization-fix/revision-validate-sdk.sh /Users/relvf/ai/pi-cross-session
git diff --check
git -C /Users/relvf/ai/pi-cross-session diff --check
```

SDK 脚本只在临时源码快照中为已有依赖建立符号链接，统一 SDK 包身份，运行结束删除它新建的快照；不安装依赖、不改两个仓库原有 node_modules。直接在 Mesh 当前安装树运行旧 bridge harness 的包身份障碍仍然存在，未通过放宽断言来掩盖；旧证据 `initial-sdk-barrier.txt` 保留。

### 失败证据与回归有效性

- 前序首次 Cross TTL 测试失败日志 `cross-first-run-test-failure.log` 保留；该轮问题与修正说明保存在旧报告。
- 本次修复前 Mesh 实跑 **83 PASS / 1 FAIL**：`review-before-fix-mesh-unit.log`。
- 新组件回归在修复前 Cross 上实跑 **19 PASS / 2 FAIL**，正是历史 latch 和独立消息丢许可：`review-before-fix-cross.log`。
- 将**保留的修复前 Cross patch**应用到其 HEAD 的临时源码副本，用新增真实 SDK 两例运行：**0 PASS / 2 FAIL**。历史取消的新许可被拒；all 模式只成功一个后继。证据 `review-before-fix-sdk.log` 包含旧源码 SHA 和失败 toolResult。相同最终测试在当前源码上 **7/7 PASS**，不是没有执行到门控的假阳性。
- 原有 `mesh-earlier-100.log`、`cross-earlier-73.log`、`sdk-final.log` 等全部保留，但不当作本轮最终全量结果。

## 修改、补丁与 SHA

Mesh：`src/continuation.ts`、`src/extension.ts`、`src/notifications.ts`、`test/unit/continuation.test.ts`、`test/unit/extension.test.ts`、`test/integration/mesh-host.test.ts`、`test/bridge/run.mjs`、`README.md`。

Cross：`lib/mesh-continuation.ts`、`extensions/cross-session.ts`、`test/mesh-continuation.test.mjs`、`README.md`。

补丁含全部当前源码/测试改动（包括 untracked 新文件），不含本报告证据目录以避免自包含：

- [mesh.patch](mesh-turn-authorization-fix/mesh.patch)，base `250a372686a6433695e0913fef4fd22d8f9fd99c`
  - SHA-256 `2cec9a33293e4f0402fd01d01a580a4239fad57b826339c4b7c1350f1164aa01`
- [cross.patch](mesh-turn-authorization-fix/cross.patch)，base `4031d9c98ceb952e7cfc00f5d429653406cbf23d`
  - SHA-256 `7334ac1daaca5f1888dcb3d0bab96ea88c21295ac74afff132c0943cea4dd074`

[revision-source-sha256.json](mesh-turn-authorization-fix/revision-source-sha256.json) 记录两仓 base commit 和所有修改源文件 SHA；[sha256.json](mesh-turn-authorization-fix/sha256.json) 包含当前报告、补丁、日志及旧证据的完整 SHA 清单。旧清单单独保留。

## 读取范围与剩余限制

重新读取了两仓 status/diff、前序报告及相关源码/测试，核对 Pi 扩展文档的 `input`、signal、message lifecycle、`agent_start/end/settled`、EventBus、`sendMessage(followUp)`；核对 SDK `sendCustomMessage` 保留 details 身份，以及 Agent followUp 队列 all 模式的真实排空语义。前序根因链与原现场 E01–E05 的读取记录在旧报告中保留。

- **没有运行全部 opt-in bridge 历史套件**；要求的 Mesh `npm test` 已全部执行，另实际运行七个双插件 SDK 续接场景。不将这七例冒称所有跨仓 bridge 功能通过。
- 不包括线上 provider、线上部署或游戏项目测试；没有新增完整 UI session-switch 端到端场景。session scope/注册 replacement/已 reserve claim 的验证已实际执行，Cross 全套也包含既有真实 SDK reload 与 managed 上下文回归。
- 同进程可信扩展/同 OS 用户仍是信任边界，不是 arbitrary Bash 或恶意同进程扩展沙箱。未来 SDK 不保留 live details 身份时会拒绝续接，不降级到可伪造文本。
- 没有扩大到完成后临时出现的任意修复任务；这类任务仍须用户授权。

## 安装与生效范围

本次修复**仅在两个源码工作树生效，没有修改当前已加载/已安装版本**。需要同时加载这两个修改后的源码扩展：若实例原本使用源码仓库，活动任务结束后由用户 `/reload`；若使用 npm 安装版本，仅 reload 不会应用本仓库修改，需用户自行切换到两份本地源码扩展或自行更新安装后再 reload，避免重复加载。

reload/会话重建会使旧许可失效。之后必须由真实用户重新发起带固定 `continuationTasks` 的新 run。历史 peer 接收锁不会被本次续接逻辑自动清除，Direct/Mesh 取消锁也不会被绕过。
