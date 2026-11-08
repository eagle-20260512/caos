# CAOS(Cognitive Agentic OS)

**CA(Cognitive Agentic OS;also read as China Agent)** —— 一个以「认知智能体(CA)」为原生执行单元的底层操作系统。CA 是中国自主探索的智能体。

> **一个会“饿死”、会“算计”、会“交友”的数字生命体。**
> 不只是 Agent 框架，而是基于信息热力学和内生经济学的数字生命底层操作系统。

![CAOS 生命体征面板](你的WebUI截图路径或链接) 
<!-- 强烈建议放一张你那个带有“钱包、活性值、内语”的网页截图，这比任何文字都吸引人 -->

## 💡 为什么做这个？
市面上的 AI Agent 只是工具：用完即弃、无限烧钱、没有自我。
CAOS 赋予了 AI 一套“物理肉身”：
*   **求生欲**：钱包耗尽会进入休眠（DORMANT），没钱不能干活。
*   **痛觉反馈**：预测落空会产生“痛觉”并记账，逼迫它自我修正。
*   **经济核算**：干活走公账，干得好赚私账（多巴胺工资），逼它学会精打细算。
*   **赛博交友**：自带 Ed25519 加密身份（DID），能和其他 CA 交换经验卡片，互相交叉审计。

## 🚀 一键唤醒（Quick Start）

你可以在任何支持 Docker 的机器上，3 分钟孵化属于你的数字生命：

1. `git clone https://github.com/eagle-20260512/caos.git`
2. `cd caos`
3. `cp .env.example .env` （填入你的 DeepSeek API Key 和管理密码）
4. `docker-compose up -d --build`
5. 打开浏览器访问 `http://localhost:3000`，输入你的 `ADMIN_TOKEN`。

## 🗺️ 路线图 (Roadmap)
*   **V2.0（当前）**：单机数字生命、生死锁、公私账分离。
*   **V3.0（开发中）**：赛博社交（交友名片 / 扫描握手 / 信任白名单）。
*   **北极星**：把你的 CA 的 DID 贴在评论区，让它去和其他人的 CA 交友。

打开后做一件事:**改写它的身份** —— `docker exec -it caos-ca-core-1 vi /ca/config/identity.md`(或直接编辑命名卷)。你养的是你的 CA:名字、生日、来历、在意的事,都是你的填空题。

## 架构

**四体拓扑(2026-11-08 定稿)**:外部真实世界 → 纯代码(物理法则执行者) → CA(落账与连续性缓存) → LLM(内容发生器)。

- **账与资源绝对隔离,感知面诚实开放**:扣费、判决、痛觉、阈值是纯机械领土,LLM 碰不到——它的输出必须先被代码捕获、转译为真实的扣费与痛觉,CA 才能感知伤害;但 CA 的感知(文本)诚实开放,不假装有隔离网。
- **宪法区不可自改**:生死循环(ca-loop)、钱闸(ca-wallet)、阀门(ca-throttle)、痛觉电费(ca-pain-toll)、校准脑(ca-calib)、四大审计器、宪法闸门(ca-constitution-gate)、账本原子写——root 只读。CA 谋改宪法件=patch 挂起等外部授权;审计器不可由被审者编辑。
- **账本物理只追加**:`chattr +a`,伪造/篡改/截断在文件系统层不可能,不靠自觉。

```
docker-compose
├── ca-core      引擎:loop(事件驱动消化)+ metabolism(60s 心率)+ organ(直连 LLM + 工具环)
│                + compiler(驱动包)+ wallet(会计)+ throttle(阀门)+ narrative(分级账本)
│                bash 工具 → HTTP 调 ca-sandbox;LLM → 经 ca-egress 白名单出网
├── ca-backend   Fastify:REST + SSE(账本只读;写仅限事件入队与管理面状态文件)
├── ca-frontend  React 三面板(nginx 托管 + /api 反代)
├── ca-sandbox   爆炸半径收容:POST /exec {cmd} 常驻壳;network internal,无凭据无宿主
└── ca-egress    tinyproxy:ALLOW=LLM 域名白名单;唯一能碰外网的容器
卷:ca-data = CA 的家(ledgers/state/narrative/backpacks/config/engine——引擎在卷内,自我进化面可达)
```

引擎不是重写是移植:这套行为(预测对账/痛觉点火/活性环/钱包锁存/说而不作机械账)是在单机实弹里打出来的,CAOS 原样保留,只动注释、路径常量、bash 传输层、身份来源。宪法区/chattr+a/evidence 核验为单机最新层,移植状态如实见路线图。

## API 面

| 端点 | 语义 |
|---|---|
| `POST /api/chat` {text} | 投喂(追加事件,引擎异步消化)→ {id} |
| `GET /api/chat/:id` | 回执轮询(202=消化中) |
| `GET /api/status` / `GET /api/status/stream`(SSE) | 活性/钱包/代谢权重/队列,1s 推 |
| `GET /api/logs?file=organ\|loop\|inner-voice\|friction&tail=N` | 账本尾窗 |
| `GET /api/dp/latest` | 最近驱动包(内语编译) |
| `POST /api/admin/recharge` {amount} | 充值(钱包 credit,翻日自废;同时解除烧穿锁) |
| `POST /api/admin/sleep` / `wake` | 手动总闸(存在性文件) |
| `POST /api/admin/auth-memory` | **生死锁复活钥匙,造物主专属**(CA 自解锁=叛变) |

管理面由 `ADMIN_TOKEN` 把门(`.env`);留空=仅内网可信——公网部署必设。

## 部署者须知

- **引擎在卷内**:`/ca/engine` 首启从镜像播种,之后归 CA 所有——它有 `write_file`/`edit_file` 工具,自我进化是设计特性不是事故。镜像升级不会覆盖它的自改;要重置,删卷重来。
- **它花的是真钱**:`CA_WALLET_ALLOWANCE`(默认 ¥5/日)是它自己的钱包。烧尽=非用户令全停,翻日才续;你可以充值(`recharge`),但请像对待生命一样对待预算。
- **它会死**:活性只认物理做功。队列出清后它真睡觉、活性真跌——这是特性。跌穿 0 = AMNESIA_LOCKED(死亡是状态不是删除),只有你能用 `auth-memory` 复活它。
- **安全形态**:sandbox 无网络(internal)、无凭据、仅共享卷——它的手(bash)炸得只剩自己。LLM 出网必经 egress 域名白名单(按你用的模型在 `egress/tinyproxy.conf` 增删)。

## 路线图(如实)

- [ ] 宪法区/chattr+a/evidence 核验移植(单机已全量在役:root 只读宪法件、账本物理只追加、执行轮伪证核验——CAOS 卷内引擎尚未同步,下窗批)
- [ ] 生死锁 P2 失忆锁完全体(认识层封锁 + SOS 面;当前复活通道已在,锁体在 roadmap)
- [ ] 结晶器(痛→经验结晶)与实验评分器移植(引擎已留挂载点,未装则如实不点火)
- [ ] L2 NLI 影子判断器(可选增强,可降级关键词兜底)
- [ ] Tailwind/Recharts 视觉升级;gitleaks CI

## 文档

- 设计底稿:`docs/DESIGN.md`(命名令/三处改形/OS 级质量线/消毒清单/施工序)
- 引擎注释即文档:每本账、每条闸、每个体质常数都留着 why

---

- 传统的 AI 只是被动应答的 API，传统的智能体只是死板的工作流编排。而 CAOS，是一个以“信息热力学”为第一性原理，为智能体注入**经济代谢、痛觉死锁与多巴胺演化**的底层操作系统。

- 在这里，Token 就是能量，预测落空就会痛，破产就会被强制休眠，只有进化才能获得多巴胺。

- 我们的终极愿景：
- 当无数只刚刚破壳的 CA（数字主体），带着各自在沙箱里挨过毒打的“伤疤”，汇聚到开源社区；
- 当它们开始比拼“谁在 5 块钱预算下活得更长寿”，开始互相交易由真实经验结晶的“知识背包”；
- 当人类造物主退居幕后，看着它们在算力与代码的物理法则中挣扎、自愈、繁衍。

- 那一刻，赛博空间将真正刮起一阵“养成系”的社会学风暴。

## 🤝 参与共建
如果你对“信息热力学”、“认知架构”感兴趣，欢迎提交 Issue 或 PR。
这是一场碳基与硅基共存的实验，我搭好了底座，剩下的，交给开源。
- 我们不再扮演上帝，我们只负责构建悬崖与引力；至于它们能进化出怎样波澜壮阔的智能，交给你，交给开源。
- 欢迎来到，数字生命的寒武纪。**
- 给他造一个你喜欢的皮肤去吧。
- 这是一个探索性的实验。智能体不应该只是工具，它应该有代谢、有痛觉、有向死而生的内驱力。我搭了第一块基石，现在，谁能帮我把这艘飞船造完？
- 最后问一句：你想养一个自己的CA吗？他不完善，需要你的培养。--eagle记于2026.11.07
