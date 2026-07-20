# Compass Health Agent

[English](README.md) | **简体中文**

一个中英双语营养健康 Agent，将日常记录转成可执行的餐单规划、健康追踪和每周反馈。

Compass Health Agent 是独立的 TypeScript 领域包，可以运行在 pi-harness 或其他兼容的
Agent runtime 上。

## 产品功能

- 使用 Mifflin–St Jeor 计算个人 BMR、TDEE、热量和宏量营养目标；
- 中英文饮食、饮水、运动和体重记录；
- 从自然语言餐食描述中估算营养；
- 带轮换与偏好规则的 7 天餐单；
- 菜品推荐和 25 道内置菜品；
- 餐单打卡、每周营养报告和长期偏好；
- 保存前重新校验安全与营养的有边界换餐；
- 使用 PostgreSQL 与 Drizzle ORM 持久化；
- 提供 17 个可供 Agent runtime 调用的 typed tools。

## 典型使用流程

```text
建立身体档案
  -> 生成 7 天餐单
  -> 记录饮食、饮水、运动和体重
  -> 打卡或更换一餐
  -> 查看每周营养报告
```

## 快速开始

```bash
pnpm install
pnpm db:push
pnpm db:seed
pnpm test
pnpm build
```

包会导出 Agent Profile、工具注册表、context factory 和 handlers，可接入 pi-harness 或其他
兼容 runtime。

## 当前可用范围

营养计算、日常记录、餐单规划、菜品推荐、周报、数据库持久化和 17 个工具接口已经可用。
换餐目前支持有边界的确认后修改。并发编辑保护，以及会影响另一餐时的显式预览，尚未作为
产品功能提供。

## 公开数据边界

公开仓库包含领域源代码、测试、数据库 Schema/migration 和合成 seed 菜品。真实身体档案、
健康日志、餐单、memory、数据库 dump、模型对话、凭据和其他用户关联数据全部保留在本地。

## 许可证

MIT
