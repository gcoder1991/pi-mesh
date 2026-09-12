# 全部修复优化与验收清单

状态：列明产品范围内实现、完整回归与独立复核已完成。最终报告页面验收按末尾交付项记录；不代表无限平台/故障覆盖。

## 基线与约束

- Mesh HEAD `5133a2888cebd1f481a94e6ef6105b6c24d1f6e0`，package0.5.0；Cross HEAD `d2eb1bc171fe5b90d3504d320f0f7857ce478661`，package1.2.1。两个工作树保留未提交修改，不声称干净。
- 原 `src/compat-extension.ts` resume 冲突提示与 `test/e2e/subagent.e2e.test.ts` 保留。恢复仍需resume/prompt/description/subagent_type；未持久化Session不能谎称已恢复。
- 单产品写者；只读review和私有源码QA可并行。未commit/push/stash/升级依赖、未重载真实用户插件或替用户启用桥接。
- 最终测试Node22.23.1，env-i与私有HOME/agentDir/TMP/XDG/cwd、npm父和后代guard；确定性本地provider，真实SDK/Unix/原生I/O按层次标注；未访问真实用户session/peer/凭据或枚举清理真实repo `.pi`。
- Bridge仅用户层settings+当前Host trust+显式Cross RPC授权；默认store，不自动唤醒/恢复/ACK/relay。Queued/accepted/submitted不证明消费或业务履约。
- 测试前114public-file manifest：`f4766cbdb0d5e036f848c78580a7e7973091581f1047b0d6a0abc251fa49c962`。本清单与最终HTML是测试后单独的文档更新；代码/测试/package仍匹配该执行快照。
- 全部证据根：`/private/tmp/pi-mesh-optimization-20260909/`；初始patch/HEAD备份在`baseline/`。

## 最终实际矩阵

| 层次 | 实际结果 | 证据（相对证据根） |
|---|---|---|
| Mesh完整npm链，083与084各自fresh | 每版 **360=80 unit/255 integration/25 E2E**，0fail/cancel/skip；types与pack47通过 | `bridge-review-third-fixes/final-verified/` |
| 单独真实SDK/Cross桥接命令 | 每版 **8 PASS**，26本地callbacks、9个正向usage断言 | 同上各版`integration.log` |
| 最终源码独立矩阵 | **249=242功能叶子+7controls，0FAIL**；四种真实双OS进程配对、Mesh三窗口、T1/T2/T3/native/unit；172本地callbacks | `bridge-last-qa/fresh-f476-20260909-01/REPORT.md` |
| Cross冻结完整suite/类型/真实CLI EOF | 每版 **57=36组件+20SDK+1guard PASS**；另独立正确依赖复跑 | `cross-review-second/acceptance/`、`bridge-final-qa/` |
| 原public Runtime replacement QA | 每版 **14 PASS/1 FAIL，runnerexit1保留** | `cross-runtime-switch/REPORT.md` |
| Missing-file实际合同独立补充 | 每版另 **1 PASS**；switch新建替换，公开rebind后才新inbox，后续交互才落盘 | `cross-missing-file-supplement/REPORT.md` |
| 最终只读代码复核 | T1/T2/T3 **VERIFIED_STATIC**，限定路径无阻断回归；未执行测试 | `final-review-verdict.md` |

## O01–O25（原始要求不改写）

| ID | 来源 | 必须达到的行为 | 当前状态 | 证据/边界 |
|---|---|---|---|---|
| O01 | F1/R4 | Host trust 显式传给 Child；资源加载不解析/安装未批准的默认包；不可信项目 shell 配置不能重新生效 | 通过：实现与当前回归、限定独立复核闭合 | runtime/HANDOFF.md; test/integration/subagent-runtime.test.ts；用户信任、预解析资源抑制及B4别名路径。 |
| O02 | F2 | queued record 从创建起有稳定 completion；共享额度双向等待/唤醒可取消；前台不提前返回 | 通过：实现与当前回归、限定独立复核闭合 | direct/HANDOFF.md; direct-lifecycle.test.ts；稳定completion、Fleet等待取消和前台交付。 |
| O03 | F3 | 专属且一致的 session 根；ready 即登记 sessionFile（不谎称文件已落盘）；缺少恢复证据明确拒绝；旧记录保留诊断而不放松任意路径边界 | 通过：实现与当前回归、限定独立复核闭合 | mesh-review-fixes/HANDOFF.md; subagent-runtime/recovery tests；真实header/批准根与逐记录隔离。 |
| O04 | F8/R2 | 同 ID continuation 串行；所有结果写入先验证 generation；停止排空和用户取消来源清楚；不显示旧轮成功正文冒充新结果 | 通过：实现与当前回归、限定独立复核闭合 | direct/HANDOFF.md; mesh-review-second/HANDOFF.md；generation、单飞调用者信号和canonical恢复身份。 |
| O05 | F9/R3 | 所有 execution 终结后一次清理；shutdown 先发扩展生命周期事件、再 dispose；close 可等待且幂等；无活会话/监听器悬挂 | 通过既定故障路径；拒绝聚合分支仅静态 | bridge-review-third-fixes/HANDOFF.md §§3–4；Runtime幂等close、多个真实Host、原生checkpoint故障drain。 最终独立bridge-last-qa/fresh-f476-20260909-01/REPORT.md。 真stable-promise拒绝聚合尚无直接永久回归，不承诺任意SDK close异常。 |
| O06 | F15 | maxTurns/timeout/cancel/错误有明确 stopReason 与 partial；错误提供具体下一步 | 通过：实现与当前回归、限定独立复核闭合 | runtime/HANDOFF.md；provider-entry guards、默认retry、partial/maxTurns/timeout及具体错误。 |
| O07 | F15 | 输出/verbose 统一有界并保留 artifact；父上下文使用 compaction-aware 完整消息，不截断原始 JSON；prompt 总预算可验证 | 通过：实现与当前回归、限定独立复核闭合 | mesh-review-second/HANDOFF.md；UTF-8/实际JSON字节预算、完整artifact与previous证据链。 |
| O08 | F12 | 通知按 generation/attempt 去重、批内不重复；前台结果与后台 follow-up 策略明确 | 通过：实现与当前回归、限定独立复核闭合 | host-review/HANDOFF.md; notifications tests；按execution去重，不混用显示/提交/消费。 |
| O09 | F13 | 查询不重复计费；模型工作按 execution/attempt 一次记账；Mesh 重试保留累计 usage | 通过：实现与当前回归、限定独立复核闭合 | mesh-review-fixes/HANDOFF.md; bridge-review-third-fixes/HANDOFF.md；前台正向usage、首次及再次查询不重领。 |
| O10 | F14 | scheduler 在 session_start（含无 UI）恢复；读取菜单不依赖新增任务；不静默丢异步错误 | 通过：实现与当前回归、限定独立复核闭合 | host-review/HANDOFF.md; scheduler tests；启动恢复、无UI、当前授权、原生写入协调。 |
| O11 | F15/R1 | resume schema/说明准确，空 ID 拒绝；损坏 Agent 定义有可见诊断，不静默掩盖路由故障 | 通过：实现与当前回归、限定独立复核闭合 | src/compat-extension.ts; test/e2e/subagent.e2e.test.ts；原resume冲突项与四个必需参数提示保留。 |
| O12 | F4/F5 | pause 排空中 resume 不丢 loop；无 loop 的 cancel 立即收敛；recover 独立收敛 cancelling | 通过：实现与当前回归、限定独立复核闭合 | mesh/HANDOFF.md; mesh-review-second/HANDOFF.md；pause/drain/recovery与pending retry/resume身份。 |
| O13 | F9/F11 | shutdown 按实际存活执行 drain；单节点等待可取消；真实 execution 结束后才释放 quota/lease | 通过：实现与当前回归、限定独立复核闭合 | mesh/HANDOFF.md; bridge-review-third-fixes/HANDOFF.md；完成/close后才释放Fleet/lease，未知停止不解锁。 最终独立bridge-last-qa/fresh-f476-20260909-01/REPORT.md。 |
| O14 | F10 | stale requester 的 pending growth 仍可 deny；approve 才执行 requester/allowlist 校验 | 通过：实现与当前回归、限定独立复核闭合 | mesh/HANDOFF.md；stale denial与有效approval分别验证，manual pause不等于growth pause。 |
| O15 | F11 | 所有 checkpoint mutation 校验 ownership/revision；双 Manager 旧快照不能覆盖活跃 run | 通过：实现与当前回归、限定独立复核闭合 | mesh-review-fixes/HANDOFF.md；原生post-rename协调、revision/lease与外来写者不覆盖。 |
| O16 | F6/R7 | 捕获 commit/patch/handoff 成功后才提交 succeeded 与 attempt result；交付失败阻断下游，纯 cleanup 失败单独告警 | 通过：实现与当前回归、限定独立复核闭合 | mesh/HANDOFF.md; mesh-review-second/HANDOFF.md；完整Git/binary patch捕获先于success，cleanup警告独立。 |
| O17 | F7 | retry/显式重试/恢复继承自身上轮已保全 commit，并处理 cwd 改变；无法保全不静默回旧基线 | 通过：实现与当前回归、限定独立复核闭合 | mesh-review-fixes/HANDOFF.md; mesh-review-second/HANDOFF.md；三路径继承、drain-first与持久用户取消授权。 |
| O18 | R1/R2 | operator 文档反映真实拓扑；paused drain 可安全检查状态/邮箱，写入与运行策略明确 | 通过：实现与当前回归、限定独立复核闭合 | mesh/HANDOFF.md；拓扑与邮件权限分离，paused-draining只允许匹配attempt的检查/ACK。 |
| O19 | R6 | 邮件显示来源/attempt；广播返回逐收件人收据，部分成功不伪装全部失败；消费与业务完成区分 | 通过：实现与当前回归、限定独立复核闭合 | mesh-review-second/HANDOFF.md; bridge-review-second-fixes/HANDOFF.md；核心IDs/outcomes不丢、ACK与release故障诚实。 |
| O20 | R3/R8 | cross 注册/heartbeat/shutdown/reload 生命周期闭合；同步/异步错误有界可见；修正 smoke 假阳性与清理 | 通过：实现与当前回归、限定独立复核闭合 | ../pi-cross-session/HANDOFF.md §7; cross-review-second/acceptance/；启动失败/heartbeat/cleanup和真实EOF smoke。 |
| O21 | R4/R5 | submitted 仍诚实表示 API 提交；来源不能授权；取消/拒收/队列/限流/重复/超时的动作建议准确 | 通过：实现与当前回归、限定独立复核闭合 | cross-review-fixes/HANDOFF.md; ../pi-cross-session/HANDOFF.md §7；默认retry停止、来源门控、逐帧/时间/去重。 |
| O22 | F15/Claude | 统一联系既有 Direct Agent 的最薄入口；按状态排队/steer/合法续跑，保持旧 resume/steer 兼容与取消防护 | 通过：实现与当前回归、限定独立复核闭合 | direct/HANDOFF.md; host-review/HANDOFF.md；send_subagent默认关闭、Host-only、精确generation，不假完成。 |
| O23 | R1/R5 | 显式启用的 mailbox 通知/实时协作，复用 Host execution，受 generation、预算与取消约束；不修改旧 mailbox 默认语义 | 通过：实现与当前回归、限定独立复核闭合 | mesh/HANDOFF.md; README.md；mailboxNotifications默认关闭，受预算/attempt/取消围栏约束。 |
| O24 | R3/组合设计 | 最薄的显式 Host 桥接，使用已确认 Pi API/事件契约；固定来源/目标，禁止 peer 授权、隐式创建拓扑或复活取消任务；无新 daemon/AgentBus | 通过：实现与当前回归、限定独立复核闭合 | bridge-review-third-fixes/final-verified/；user-only固定映射、Cross RPC、被动存储/active围栏与T1/T2；T1/T2/T3最终STATIC认可。 最终独立bridge-last-qa/fresh-f476-20260909-01/REPORT.md。 |
| O25 | R8 | 跨 SDK 0.83/0.84、双 OS 进程、多 Session、歧义/旧 ref、busy/idle/refuse、断线/重放/边界和清理的真实 SDK 测试 | 所列真实矩阵通过；保留历史失配与环境边界 | bridge-last-qa/fresh-f476-20260909-01/REPORT.md；cross-runtime-switch原14/1每版保留，cross-missing-file-supplement另1PASS每版。生产TUI/Windows/真实provider未声称通过。 |

## 历史失败与执行偏差（不抹绿）

- **D1**：早期旧tarball用例在私有解包目录执行过`npm install --omit=dev --ignore-scripts`。workspace依赖未改，但不能排除registry访问，违反禁止安装要求；后来改成离线pack/unpack/loader，原日志保留。
- **D2**：首次Direct typecheck npm父未预加载guard并出现更新提示，不能排除update-check；后来父及后代均受guard，不追称历史全离线。
- **D3**：旧manager测试使用repo cwd，可能写入合成`.pi`状态；已修为私有cwd并断言实际路径。没有读/删真实`.pi`分类，也不推断用户记录被访问。
- 原生命周期/通知复现、Cross abort后自动后继、SDK版本适配原FAIL、B1–B4及S1–S6旧回归、T1/T2最终旧src每版12PASS/6FAIL均保留。BUG_REPRODUCED/exit0不是修复验收。
- 独立旧cd9为74/11、f6为84/7；01250独立selected318/0但all-exec375/1，含错误typebox前置条件。它们不认证最后f476源码。
- 原missing.jsonl负测预期拒绝不符合两版观察到的SDK行为，原14/1和exit1仍保留；新增合同观察不替代该负测，也不解释在线Agent未持久化原因。
- 原fixture语法/type/查询通知timeout、证据TAP解析失败均留档。主审最后首次解析仅看外层file-count1误与26leaf比较，纠正精确嵌套解析后PASS，未改任何测试。

## 非阻断与范围限制

- 真stable-promise拒绝→两层AggregateError→失败entry/owner保留分支只静态核验，未直接永久回归。单纯checkpoint失败或被settle捕获的close异常不能伪装为该拒绝分支。
- T2只认证一次abort-checkpoint native fault且实际close正常的路径；不承诺任意第三方SDK abort/close异常能证明关闭。shutdown resolve不等于全部checkpoint durable；诊断为Manager内存/Host事件，不承诺跨restart持久。
- Windows、生产TUI/Escape、真实provider/计费/凭据、所有不可观察取消阶段、永久介质故障/跨文件断电exactly-once、恶意同UID/OS sandbox未声称通过。
- Node guard不是OS网络沙箱；内部Git限制不禁止独立授权的Bash、clean/smudge filters或setup hooks。
- 旁会话Agent resume未持久化、Queued后未落实补充反馈只作未归因记录；没有检查/中断其真实run，未重载插件。

## 最终交付核对

- [x] 两项目完整测试、类型和实际CLI/pack检查按源码/版本分层通过。
- [x] 原报告与后续确认缺陷修复并有正确回归，独立限定复核无阻断项。
- [x] 当前源码真实SDK、多进程、停止/权限/故障/重启矩阵完成，原始产物与SHA复核。
- [x] O01–O25原始要求、全部历史FAIL、D1–D3与未覆盖边界保留。
- [x] HTML渲染器预检：桌面真实PNG、390px浏览器DOM布局、过滤、JSON原生下载与复制失败回退；正式文件内容再经后置核验。

最终报告：`docs/reports/optimization-acceptance-report.html`。正式文件的后置页面验收证据及SHA记录在证据根`report-browser-final.json`，不构造自包含文件对自身SHA的循环签名。预检13次工具调用失败记录见`report-browser-preflight.json`；移动PNG截图超时，移动布局以真实浏览器390px DOM/计算样式验证，不冒充真实设备或已取得移动截图。
