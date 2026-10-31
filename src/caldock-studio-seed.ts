// Public V4 planning defaults, independent from commerce prices.
export const studioSeed = {
  "schema": 4,
  "scenarios": {
    "pilot": {
      "name": {
        "zh": "10 台 · 试点",
        "en": "10 units · Pilot"
      },
      "values": {
        "machines": 10,
        "blocked": 2,
        "occupancy": 80,
        "monthly": 199,
        "quarterly": 169,
        "annual": 129,
        "annualShare": 70,
        "quarterlyShare": 20,
        "purchase": 899,
        "purchaseTax": 7.75,
        "networkSetup": 800,
        "ups": 600,
        "fitout": 500,
        "watts": 30,
        "networkWatts": 60,
        "electricity": 0.3,
        "cooling": 1.6,
        "network": 200,
        "software": 8,
        "support": 10,
        "labor": 500,
        "other": 100,
        "rent": 0,
        "marketing": 100,
        "launchBudget": 540,
        "payment": 3,
        "refund": 2,
        "replacement": 10,
        "life": 36,
        "residual": 20,
        "monthlyFirst": 20,
        "monthlyRepeat": 10,
        "quarterCommission": 8,
        "annualCommission": 8,
        "monthlyRenew": 100,
        "quarterlyRenew": 100,
        "annualRenew": 100,
        "horizon": 36,
        "saleResidual": 20
      }
    },
    "scale50": {
      "name": {
        "zh": "50 台 · 复制",
        "en": "50 units · Scale"
      },
      "values": {
        "machines": 50,
        "blocked": 3,
        "occupancy": 80,
        "monthly": 199,
        "quarterly": 169,
        "annual": 129,
        "annualShare": 70,
        "quarterlyShare": 20,
        "purchase": 899,
        "purchaseTax": 7.75,
        "networkSetup": 2000,
        "ups": 2500,
        "fitout": 5000,
        "watts": 30,
        "networkWatts": 180,
        "electricity": 0.3,
        "cooling": 1.6,
        "network": 400,
        "software": 8,
        "support": 10,
        "labor": 1500,
        "other": 250,
        "rent": 0,
        "marketing": 350,
        "launchBudget": 1200,
        "payment": 3,
        "refund": 2,
        "replacement": 10,
        "life": 36,
        "residual": 20,
        "monthlyFirst": 20,
        "monthlyRepeat": 10,
        "quarterCommission": 8,
        "annualCommission": 8,
        "monthlyRenew": 100,
        "quarterlyRenew": 100,
        "annualRenew": 100,
        "horizon": 36,
        "saleResidual": 20
      }
    },
    "scale100": {
      "name": {
        "zh": "100 台 · 运营",
        "en": "100 units · Operate"
      },
      "values": {
        "machines": 100,
        "blocked": 5,
        "occupancy": 80,
        "monthly": 199,
        "quarterly": 169,
        "annual": 129,
        "annualShare": 70,
        "quarterlyShare": 20,
        "purchase": 899,
        "purchaseTax": 7.75,
        "networkSetup": 4000,
        "ups": 5000,
        "fitout": 10000,
        "watts": 30,
        "networkWatts": 300,
        "electricity": 0.3,
        "cooling": 1.6,
        "network": 900,
        "software": 8,
        "support": 10,
        "labor": 2800,
        "other": 450,
        "rent": 0,
        "marketing": 650,
        "launchBudget": 2000,
        "payment": 3,
        "refund": 2,
        "replacement": 10,
        "life": 36,
        "residual": 20,
        "monthlyFirst": 20,
        "monthlyRepeat": 10,
        "quarterCommission": 8,
        "annualCommission": 8,
        "monthlyRenew": 100,
        "quarterlyRenew": 100,
        "annualRenew": 100,
        "horizon": 36,
        "saleResidual": 20
      }
    }
  },
  "marketing": {
    "strategy": {
      "zh": "先拿下能影响购买的人，而不是只追求播放量。\n核心伙伴：自己用 AI 做工作流、有付费学员或企业客户的实战讲师、培训 / IP 陪跑主理人、企业 AI 实施顾问（FDE）。\n路径：真实体验 → 可公开的项目成果 → 联合演示 / 课程 → 学员与企业客户独立租机。\n卖点：持续工作的独享开发环境、专业交付形象与中文支持。月付降低门槛，季付承接项目，年付锁定长期使用。",
      "en": "Win people who influence purchases, not just views.\nCore partners: hands-on AI workflow trainers, paid-cohort / personal-brand coaches, and enterprise AI implementation consultants (FDEs).\nPath: real use → permissioned project case → joint demo / workshop → independent rentals by students and business clients.\nValue: a dedicated always-on development workspace, professional delivery, and Chinese-language support. Monthly lowers commitment, quarterly fits projects, annual serves sustained usage."
    },
    "outreach": {
      "zh": "你好，看了你最近的【具体项目】，你把 AI 用到实际交付里的方式很契合我们。我们在加州做独享 Mac 工作台，想邀请你用自己的一个真实任务验证，而不是只发广告。你继续做培训和企业实施，我们负责设备与基础环境。验证通过后，可以共创案例、联合演示，并按实际租赁成交结算。方便约 15 分钟看一下实机吗？",
      "en": "Hi, I saw your recent [specific project]. Your practical AI delivery work fits what we are building: dedicated Mac workspaces in California. We would like you to test a real task of your own, rather than simply post an ad. You keep the training and consulting relationship; we provide the device and base environment. After validation, we can develop a case study, host a joint demo and pay for attributed rental sales. Could we arrange a 15-minute live demo?"
    },
    "pitch": {
      "zh": "先确认你的任务能跑通，再选租期。月付 ${monthly}/月；季付共 ${quarterTotal}，折合 ${quarterly}/月；年付一次 ${annualTotal}，折合 ${annual}/月，比连续月付一年节省 ${annualSaving}。机租不默认包含模型订阅、定制开发或无限陪跑。以书面交付与退款条款为准。",
      "en": "Validate your task first, then choose a term. Monthly: ${monthly}/mo. Quarterly: ${quarterTotal} upfront (${quarterly}/mo). Annual: ${annualTotal} upfront (${annual}/mo), saving ${annualSaving} versus 12 monthly payments. Model subscriptions, custom development and unlimited consulting are not included by default. Written delivery and refund terms apply."
    },
    "content": {
      "zh": "01 关掉本地电脑之后，这次 App 构建是否继续？\n02 美国仓库实拍：机器、网络与故障由谁负责？\n03 租还是买？把年付、维护和使用频率算清楚。\n04 一位 AI 实战讲师如何准备企业演示。\n05 真实客户 7 天任务验证：结果与踩坑。\n06 哪些人不需要租一台 Mac？主动劝退不合适的人。\n优先视频号 / 微信与小红书；B 站承接完整演示，抖音复用有效素材。每条内容只给一个下一步。",
      "en": "01 Does the App build continue after your laptop disconnects?\n02 Inside the California facility: who owns hardware, network and incident response?\n03 Rent or buy? Compare annual payment, maintenance and usage.\n04 How an AI trainer prepares an enterprise demo.\n05 A real 7-day task test: results and lessons.\n06 Who does NOT need a rented Mac?\nPrioritize WeChat Channels / WeChat and Xiaohongshu. Use Bilibili for full demos and reuse proven clips on Douyin. Give each post one clear next step."
    },
    "automation": {
      "zh": "AI：整理公开商务线索与来源 → 按受众和真实项目评分 → 起草个性化邀约 → 记录演示、试用、到期跟进 → 汇总渠道转化。\n人工：确认身份与用途资格、发送邀约、批准价格承诺、处理异议及交付。\n不购买私人号码，不批量骚扰，不收集账户密码。此工作台仅记录计划，不会自动发消息。",
      "en": "AI: organize public business leads with sources → score audience fit and real projects → draft personalized outreach → track demos, trials and renewal follow-up → summarize conversion.\nPeople: verify identity and use eligibility, send outreach, approve commercial promises, handle objections and deliver.\nDo not buy private phone lists, send bulk harassment or collect account passwords. This workbench records plans; it does not send messages."
    },
    "stopRules": {
      "zh": "10 → 50：至少 8 台付费；有 2 个真实案例；连续两周按时交付；单台贡献为正；候补需求可核验；采购不动用履约准备。\n50 → 100：连续两个月至少 40 台在租；两条渠道各带来 ≥3 位付费客户；有 30/60 日活跃证据；售后成本可控。\n年付要满 12 个月才有年续约证据。\n单台贡献持续为负、退款或故障升高、服务资格或供应商授权不清，暂停对应套餐与扩容。",
      "en": "10 → 50: at least 8 paying units, 2 real case studies, two weeks of on-time delivery, positive unit contribution, verified waiting list, and no use of service reserves for capex.\n50 → 100: at least 40 occupied units for two months, two channels each delivering ≥3 paying customers, 30/60-day active-use evidence and controlled support cost.\nAnnual renewal cannot be validated until a full 12 months have passed.\nPause affected plans and expansion when contribution stays negative, refunds/incidents rise, or eligibility / supplier authorization is unclear."
    },
    "channels": {
      "creator": {
        "name": {
          "zh": "达人 / 实施伙伴",
          "en": "Creator / implementation partners"
        },
        "budget": 250,
        "leads": 15
      },
      "content": {
        "name": {
          "zh": "自有内容",
          "en": "Owned content"
        },
        "budget": 150,
        "leads": 12
      },
      "workshop": {
        "name": {
          "zh": "联合工作坊",
          "en": "Joint workshops"
        },
        "budget": 100,
        "leads": 8
      },
      "tools": {
        "name": {
          "zh": "AI线索工具 / 承接",
          "en": "Lead tools / conversion"
        },
        "budget": 40,
        "leads": 5
      }
    },
    "funnel": {
      "leads": 40,
      "demo": 60,
      "trial": 60,
      "close": 60
    },
    "tasks": {
      "t1": {
        "title": {
          "zh": "核验首期 10 台库存与真实可交付数",
          "en": "Verify the 10-unit pilot and actual available inventory"
        },
        "owner": "",
        "due": "2026-11-01",
        "done": false
      },
      "t2": {
        "title": {
          "zh": "完成收款、退款、重启和交接测试",
          "en": "Test payment, refunds, restart and device handover"
        },
        "owner": "",
        "due": "2026-11-01",
        "done": false
      },
      "t3": {
        "title": {
          "zh": "建立 30 位达人名单，优先邀约 10 位",
          "en": "Build a 30-partner list; approach the first 10"
        },
        "owner": "",
        "due": "2026-11-02",
        "done": false
      },
      "t4": {
        "title": {
          "zh": "录制第一个真实任务案例与实机演示",
          "en": "Record the first real task case and live demo"
        },
        "owner": "",
        "due": "2026-11-02",
        "done": false
      },
      "t5": {
        "title": {
          "zh": "逐单完成用途与资格核验，再放单",
          "en": "Qualify intended use and eligibility before accepting orders"
        },
        "owner": "",
        "due": "2026-11-02",
        "done": false
      },
      "t6": {
        "title": {
          "zh": "供应商寻源、核验授权与责任（独立于机租）",
          "en": "Source suppliers; verify authorization and liability separately"
        },
        "owner": "",
        "due": "2026-11-06",
        "done": false
      },
      "t7": {
        "title": {
          "zh": "复盘首个任务完成、售后工时与渠道回款",
          "en": "Review task completion, support time and attributed receipts"
        },
        "owner": "",
        "due": "2026-11-09",
        "done": false
      }
    }
  }
};
export const studioRanges:Record<string,[number,number]> = {"machines":[1,10000],"blocked":[0,10000],"occupancy":[0,100],"monthly":[0,10000],"quarterly":[0,10000],"annual":[0,10000],"annualShare":[0,100],"quarterlyShare":[0,100],"purchase":[0,100000],"purchaseTax":[0,50],"networkSetup":[0,10000000],"ups":[0,10000000],"fitout":[0,10000000],"watts":[0,1000],"networkWatts":[0,100000],"electricity":[0,10],"cooling":[1,5],"network":[0,1000000],"software":[0,10000],"support":[0,10000],"labor":[0,1000000],"other":[0,1000000],"rent":[0,1000000],"marketing":[0,1000000],"launchBudget":[0,1000000],"payment":[0,50],"refund":[0,50],"replacement":[0,100],"life":[1,120],"residual":[0,100],"monthlyFirst":[0,100],"monthlyRepeat":[0,100],"quarterCommission":[0,100],"annualCommission":[0,100],"monthlyRenew":[0,100],"quarterlyRenew":[0,100],"annualRenew":[0,100],"horizon":[12,60],"saleResidual":[0,100]};
