# Compass Health Agent

[English](README.md)

双语（中英文）健康营养 Agent —— 卡路里追踪、餐单规划、菜谱推荐、每周营养报告。

独立的 TypeScript 库，包含 12 个工具处理器、PostgreSQL 持久化层，以及基于 Mifflin-St Jeor 公式的卡路里引擎。通过导出的工具注册表接入任意 LLM Agent 框架。

## 功能特性

- **卡路里引擎** —— BMR（Mifflin-St Jeor）、TDEE、目标调整后的卡路里限额，以及完整的宏量营养素分配（蛋白质/碳水/脂肪），带安全下限与回溯机制
- **营养估算** —— 解析中英文自由文本的餐食描述，输出结构化营养数据。CJK 感知的文本分割：正确拆分中文食物条目，不会破坏英文多词食物名称
- **饮食 / 饮水 / 运动 / 体重记录** —— 自然语言输入解析（如 `"2杯水"`、`"跑步30分钟"`、`"72.5kg"`）
- **7天餐单规划** —— 贪心选菜 + 每餐位卡路里目标 + 食材连续性约束（同一食材不超过连续3餐）+ 调味料偏好过滤
- **菜谱推荐** —— 基于卡路里匹配度、蛋白质目标、近期重复惩罚、食材多样性和用户偏好的综合评分排名
- **每周营养报告** —— 宏量营养素比例、达标率、钠摄入趋势分析、微量营养素缺口检测、可操作建议
- **14道预设菜品 + 自定义菜品** —— 内置14道基于真实营养数据校准的菜品；用户也可通过烹饪记录添加自己的菜品
- **双语国际化** —— 所有面向用户的模板均提供中英文版本

## 架构

```
src/
├── engine/          # 纯计算层（卡路里、餐单规划、菜谱引擎、营养、自然单位、模式检测）
├── tools/           # 工具处理器（12个工具 + 2个智能包装器）、营养估算、候选菜品加载
├── db/              # PostgreSQL 表结构（Drizzle ORM）、仓储层、种子数据、目录加载
├── data/            # 预设菜品定义
├── i18n.ts          # 双语模板渲染器
├── agent.ts         # Agent 配置与工具注册
└── index.ts         # 工具注册表与 CLI 入口
tests/
├── engine/          # 卡路里、餐单规划、菜谱引擎、自然单位、营养、模式检测
├── tools/           # 记录、每日总结、每周报告、餐单
├── handlers/        # 集成测试
└── db/              # 表结构与数据库集成测试
```

## 工具列表

| 工具 | 权限 | 描述 |
|------|------|------|
| `set_profile` | 写入 | 设置身体档案，计算 BMR/TDEE/宏量目标 |
| `nutrition_estimate` | 只读 | 从自由文本食物描述估算营养 |
| `log_meal` | 写入 | 记录一餐并自动解析营养 |
| `log_water` | 写入 | 从自然语言记录饮水量 |
| `log_exercise` | 写入 | 记录运动并自动估算消耗卡路里 |
| `log_weight` | 写入 | 记录体重 |
| `daily_summary` | 只读 | 汇总一天的营养、饮水和运动数据 |
| `weekly_report` | 只读 | 7天营养报告，含趋势与建议 |
| `recipe_recommend` | 只读 | 按匹配度和多样性推荐菜品 |
| `generate_meal_plan` | 写入 | 生成并持久化7天餐单 |
| `meal_checkin` | 写入 | 确认、替换或跳过已计划的餐食 |
| `update_cooking_record` | 写入 | 保存或更新个人烹饪记录 |

智能包装器（`generate_meal_plan`、`recipe_recommend`）会自动加载用户的 BMR 档案、候选菜品和调味料偏好，再调用底层引擎。

## 技术栈

- **运行时**：Node.js + TypeScript（ES2022，NodeNext 模块）
- **数据库**：PostgreSQL + Drizzle ORM
- **测试**：Vitest（16个测试文件，73个测试用例）
- **构建**：`tsc`

## 快速开始

```bash
# 安装依赖
npm install

# 配置 PostgreSQL（默认：postgres://compass:compass@localhost:5433/compass_health）
export DATABASE_URL="postgres://compass:compass@localhost:5433/compass_health"

# 推送表结构并导入种子数据
npm run db:push
npm run db:seed

# 运行测试
npm test

# 构建
npm run build
```

## 集成方式

Agent 导出了类型化的工具注册表，可接入任意 LLM Agent 框架：

```typescript
import { initToolContext, invokeTool, profile } from "compass-health-agent";

const ctx = await initToolContext({
  externalUserId: "user-123",
  locale: "zh",
});

// 按名称调用任意工具
const summary = await invokeTool(ctx, "daily_summary", { date: "2026-06-18" });

// 或直接使用单个处理器
import { handlers } from "compass-health-agent";
const plan = await handlers.handleSmartGenerateMealPlan(ctx, {});
```

## 许可证

MIT
