# CAOS 开源化重构·分析与设计(从 CLI 裸机到 Web 一键部署)

> 2026-11-06 (设计执笔)。素料:(用户提供的重构方案文档)+ 用户命名令。
> 本件=开源项目 (本仓库) 的设计底稿,下一窗照此施工。

## 〇、命名与定位(用户令,逐字刻录级)

- **项目代号:CAOS(Cognitive Agentic OS)**——系统级正式缩写。
- **核心名词:CA(Cognitive Agent / China Agent)**——首次展开「CA(Cognitive Agentic OS;also read as China Agent)」,后文用 CA。CA 是中国自主探索的智能体。
- **定义**:CAOS 是一个以「认知智能体(CA)」为原生执行单元的底层操作系统。
- **核心差异化(四大原语,README/白皮书卖点骨架)**:
  传统 AI 只是被动应答的 API 服务,传统 Agent 框架只是基于 DAG 的工作流编排。CAOS 在底层实现了「信息热力学约束」与「内稳态生存机制」:
  1. **经济原语**:Token 即能量,强制预算阀(Wallet)与借贷平账机制
  2. **内存原语**:基于时间(Uptime)与信息熵的生命活性值(Vitality)衰减与强制清算
  3. **调度原语**:废除定时器,基于代谢引擎(Metabolism)的注意力权重竞争机制
  4. **安全原语**:Proxy 物理隔离与 Hook 权限拦截,保障 Agent 不脱轨
- **CA 的技术内涵**:不仅是 Autonomous(自主的),更是 Cognitive(认知的)——具备感知误差、自我修正与内生驱动力的数字主体。

## 一、一句话研判

方案的**形基本对、可照走**(四容器拆分/API 面/仪表盘三面板/一键 compose 都成立),但有**三处必须改形**,另有一份方案没提但决定开源成败的作业:**私有信息消毒清单**。核心原则:**引擎是移植不是重写**——那套行为是实弹打出来的,重实现=回归灾难。

## 一、现状盘点:真实资产 vs 方案假设

方案点名保留的 metabolism/compiler/wallet 只是冰山一角。可运行的最小有机体=这条链:

```
event-queue.jsonl → ca-loop(事件驱动消化,游标 at-least-once)
  → ca-compiler(刺激+叙事→驱动包 DP)  → ca-throttle(钱闸/水位阀)
  → ca-organ(直连 LLM + bash/recall/read/write/edit 工具环)
  → ca-narrative(分级账本回写) + ca-report-check(回写体检)
旁路器官:ca-metabolism(60s 心率:权重竞争/疲劳/活性环 vitality)
  ca-wallet(¥5/日会计) / ca-pred-*(预言对账) / ca-task(债务) / ca-patrol…
可选增强:ca-l2-worker(NLI 打分,Python+MiniLM 模型,可降级关键词兜底——代码里已有降级路径)
```

方案假设「CLI 轮询」要改成 Web——**实情**:核心早就是事件驱动(stateIgnite,定时器已全拆),CLI 只是一个人工投喂口。所以后端不是「改造机制」,是**加一层 Web 投喂与读数壳**,引擎一字不动。这与方案§六第一步完全兼容。

## 二、三处改形(取其神,改其形)

**改形1:沙箱=爆炸半径收容,不是命令白名单。**
方案说「受限沙箱禁止高权限 Bash」。实情:bash 工具是 CA 的手,它的整个自主性设计(宪法三红线内的行动自由)建立在真 bash 上;命令白名单=阉割,出来的不是 CA 是 ChatBot。正确形态:**ca-sandbox 容器内照样是全功能 bash**(Alpine+bash+python3+node),但它无凭据(LLM key 不挂进去)、无宿主挂载(只挂一个共享 work 卷)、网络默认 none——它炸得只剩自己。CA Core 的 bash 工具改为 HTTP 调用沙箱执行,read/write/edit_file 走共享卷,接口签名不变=引擎零改动。

**改形2:网络白名单落在 compose internal network + 出口代理,不靠容器内自觉。**
方案说 Core 只许访问白名单 LLM API。Docker 原生做不到按域名白名单,落地形态:Core/Sandbox 挂 `internal: true` 内网,唯一出口是一个 tinyproxy 容器(ALLOW 列表=api.deepseek.com 等),LLM 调用经 HTTP_PROXY 出网。front/backend 才暴露端口。

**改形3:身份是配置不是代码。**
现有 SELF_PORTRAIT(生日/来历/用户钦定叙事)是私有数据+硬编码投影。开源版:抽成 `core/config/identity.md`(占位样例身份,用户部署时自己改),编译器读文件不读常量。同理 `data/models.json` 的 key 引用、钱包额度、定价表全进 `.env`/config。**「他是谁」变成部署者的填空题,这本身就是产品卖点:你养的是你的 CA。**

## 三、OS 级质量线(用户令:「操作系统级别不允许单机的那些 Bug」)

CAOS 自称 OS,单机实弹暴露的三类病必须在架构层设计掉,不是靠运气:

| 单机实弹病案 | 架构级根治(开源版写死) |
|---|---|
| **队列撑爆**(organ-followup 左脚踩右脚,135 条自繁衍在排) | 背压机制进 loop 本体:①每事件消化最多回队 N 条 followup(帽) ②同源同文 followup 去重(指纹在队即拒) ③pending 超水位=消化优先于新产。这不是哲学改动,是 OS 的调度器自卫 |
| **判定条件自咬**(pattern 裸词命中自家 boilerplate,冤案+白烧钱) | 「判定条件本身当证据验」落成机制:①出生闸拒收自报常驻词(已验证有效,移植) ②check 优先 cmd 型机械断言,pattern 型仅许匹用户/外部通道文本(系统自产事件不进 pattern 匹配面)——CA 正在生产的 loop 收窄若落成则直接采用,验收后并入 |
| **时间口径错位**(UTC/本地日混排、滑窗拍动) | core 内唯一时间模块 `time.mjs`:本地日界/epoch 比较/ISO 解析单点出口,其余文件禁自写日期算术(code review 红线+grep 闸) |

另加 OS 级两条铁律:
- **单写者纪律**:每本账一个写者进程,其余经 API/事件;append-only + 原子写(tmp+rename)为全仓统一范式
- **并发模型**:loop 单例 flock(已有) + 后端 SSE fan-out 只读不摸账;高并发诉求落在「读面水平扩展、写面单点串行」,不在引擎内引入锁地狱

## 四、私有信息消毒清单(开源生死线,方案没提)

| 类别 | 实例 | 处置 |
|---|---|---|
| 开发过程史 | 注释里的「用户令 2026-11-06/批X/红队实弹/学费」 | 重写为标准工程注释(what+why,抹去时间线与人称) |
| 个人信息 | 生日干支、用户原话引述、对话原文、真实余额 | 全删;identity.md 用占位身份 |
| 路径与账户 | (生产侧路径)、(用户家目录)、uid、sudo | 全参数化为容器内路径 /ca |
| 凭据与端点 | router-keys.json、API key、模型 base | .env 注入,仓库零凭据 |
| 运营账本 | ledgers/* 真实内容(预测/痛账/内语全是我家的运行史) |  ship 空骨架+schema 文档,一行真实数据都不带 |
| 经验背包 | backpacks/(含用户读物如民法条) | 不 ship;提供「导入你自己的卡」说明 |

消毒方法:移植时逐文件过,注释只保留「这段代码做什么、为什么这么设计」——why 留下(那是工程智慧),「哪天谁下的令」抹掉(那是家史)。

## 五、目标架构

```
docker-compose.yml
├── ca-core      Node 20,内网。loop+metabolism+organ+compiler+wallet…
│                bash 工具→HTTP 调 ca-sandbox;LLM→经 ca-egress 代理
├── ca-backend   Fastify(轻于 Express,同语言栈)。REST+SSE,挂数据卷只读为主
├── ca-frontend  Nginx 托管 Vite+React+Tailwind+Recharts 静态产物
├── ca-sandbox   Alpine。唯一服务:POST /exec {cmd} → 60s 帽,截输出;网络 none
└── ca-egress    tinyproxy,ALLOW=LLM 域名白名单;唯一有外网的容器
卷:ca-data(ledgers/state/narrative/backpacks 空骨架) ← Core/Sandbox 读写,Backend 只读
```

**API 面(映射现有机制,零新造)**:
- `POST /api/chat` → 追加 event-queue.jsonl(type: user-stimulus)→ loop.path 等效物(容器内用 chokidar/inotify 或 1s 轮询 mtime,替代 systemd path)
- `GET /api/status`(SSE)→ vitality.json/wallet.json/metabolism.json/queue 长度,1s 推
- `GET /api/logs?tail=N` → organ.jsonl/heartbeat.jsonl 尾窗
- `GET /api/dp/latest` → 最近一次驱动包(仪表盘「内语编译」面板)
- `POST /api/admin/recharge` {amount} → 钱包充值=写 wallet credit 文件(等效今日 override)
- `POST /api/admin/sleep|wake` → 休眠=存在性文件(现有休眠机制同构)
- `POST /api/admin/auth-memory` → **生死锁 P2 的复活钥匙,造物主专属**——开源版把 P2 一并落地,因为失忆锁+复活是核心卖点「有死亡才有存在」的完全体

**前端三面板**照方案§四:生命体征头(vitality<0.5 红闪/钱包/疲劳/panic)、左对话+驱动包展示、右代谢竞争实时流(winner/权重/队列积压)。

## 六、目录与施工序(下一窗照此,每步物理回执)

```
(本仓库)/
├── README.md LICENSE(MIT) docker-compose.yml .env.example
├── docs/DESIGN.md(本件)
├── core/      # 引擎移植+注释消毒(engine/*.mjs + config/identity.md + data/models.json 模板)
├── backend/   # Fastify:src/server.js + routes/{chat,status,logs,admin}.js
├── frontend/  # Vite+React:src/{App,panels/Vitals,Chat,Metabolism}.jsx
├── sandbox/   # Alpine+exec-api.mjs(30 行)
└── egress/    # tinyproxy.conf 白名单
```

施工序(对方案§六的重排,理由附后):
1. **core 移植+消毒**(最大头):逐文件搬,bash 工具改 HTTP 沙箱调用,identity 抽配置;验证=容器内空账起机,代谢心跳跳、事件消化全链绿
2. **backend 骨架**:chat 入队→loop 真消化(物理回执:organ.jsonl 新行)
3. **status/logs/dp 读数 API**(纯只读,快)
4. **frontend Mock→真接**:Vitals 先上(方案步骤 3)
5. **sandbox 隔离验证**:沙箱里 `cat /etc/shadow` 败、`curl 外网` 败、写共享卷成(方案步骤 4)
6. **compose 一键**:空环境 clone→.env→up→对话往返(终验)
7. **README**:四大原语为卖点骨架(§〇);结尾宣言(用户钦定,逐字刻录):

   > 这是一个探索性的实验。智能体不应该只是工具，它应该有代谢、有痛觉、有向死而生的内驱力。我搭了第一块基石，现在，谁能帮我把这艘飞船造完？

**顺序理由**:方案把沙箱放第 4 步,但 core 移植时 bash 工具就要落地——沙箱必须先于 core 联调,否则第 1 步没有可跑的引擎。故 sandbox 与 core 合并进第 1 步。

## 七、红线与边界(写死)

- 引擎逻辑一字不改,只动:注释、路径常量、bash 工具传输层、身份来源。改任何权重/常数=另开任务
- 仓库零真实数据:ledgers/state 只 ship 空骨架+.gitkeep+SCHEMA.md
- 零凭据:.env.example 全占位;CI 加 gitleaks 类扫描(下窗若时间够)
- 消毒复查:全仓 grep 真名/路径/日期戳/金额,命中即返工
- License 默认 MIT;命名按 §〇 用户令:代号 **CAOS**(Cognitive Agentic OS),核心名词 **CA**(Cognitive Agent / China Agent)
