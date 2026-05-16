# 12306 火车票查询 & AI 换乘推荐

[Clawhub](https://clawhub.ai/kirorab/12306) Skill — 查询中国铁路 12306 列车时刻表、余票信息，以及 AI 驱动的智能换乘推荐。

## 安装

```bash
npx skills add kirorab/12306-skill
```

## 依赖

- Node.js >= 18
- OpenAI API Key（可选，仅 AI 换乘排序需要）

## 功能

### 直达查询 `query.mjs`

查询任意两站间的列车时刻表和余票。

```bash
# 北京到上海所有列车
node scripts/query.mjs 北京 上海

# 高铁二等座有票，上午出发
node scripts/query.mjs 上海 杭州 -t G --depart 06:00-12:00 --seat ze

# 仅可购票，18点前到达
node scripts/query.mjs 深圳 长沙 --available --arrive -18:00

# Markdown / JSON 输出
node scripts/query.mjs 广州 武汉 -f md
node scripts/query.mjs 成都 重庆 --json
```

### AI 换乘推荐 `transfer.mjs`

BFS 广度搜索所有可能的换乘站，LLM 根据用户偏好智能排序和推荐。

```bash
# 基础换乘搜索（最多 3 次换乘）
node scripts/transfer.mjs 北京 上海

# 带偏好排序（需要 OPENAI_API_KEY）
node scripts/transfer.mjs 北京 广州 --preference "省钱优先"

# 限制换乘次数 + 最少换乘时间
node scripts/transfer.mjs 北京 深圳 --max-transfers 1 --min-transfer 20

# 纯算法排序（无需 API key）
node scripts/transfer.mjs 武汉 上海 --no-llm

# JSON / HTML 输出
node scripts/transfer.mjs 成都 重庆 -f json
node scripts/transfer.mjs 北京 上海 -f html
```

### 站点查询 `stations.mjs`

```bash
node scripts/stations.mjs 杭州
node scripts/stations.mjs 香港西九龙
```

## 参数参考

### query.mjs

| 参数 | 说明 |
|------|------|
| `-d, --date <YYYY-MM-DD>` | 出行日期，默认今天 |
| `-t, --type <G\|D\|Z\|T\|K>` | 车次类型筛选，可组合（如 `GD`） |
| `--depart <HH:MM-HH:MM>` | 出发时间范围 |
| `--arrive <HH:MM-HH:MM>` | 到达时间范围 |
| `--max-duration <duration>` | 最长耗时（如 `2h`、`90m`） |
| `--available` | 仅显示可购票车次 |
| `--seat <types>` | 按座位类型筛选（`swz,zy,ze,rw,dw,yw,yz,wz`） |
| `-f, --format <html\|md>` | 输出格式，默认 html |
| `-o, --output <path>` | 输出文件路径（html 模式） |
| `--json` | JSON 输出到 stdout |

### transfer.mjs

| 参数 | 说明 |
|------|------|
| `-d, --date <YYYY-MM-DD>` | 出行日期，默认今天 |
| `--max-transfers <n>` | 最大换乘次数，默认 3 |
| `--min-transfer <minutes>` | 最小换乘时间（分钟），默认 10 |
| `--preference <text>` | 用户偏好描述，传给 LLM 排序 |
| `-t, --type <G\|D\|Z\|T\|K>` | 车次类型筛选 |
| `--seat <types>` | 座位类型筛选 |
| `-f, --format <md\|html\|json>` | 输出格式，默认 md |
| `--model <name>` | OpenAI 模型，默认 `gpt-4o-mini` |
| `--no-llm` | 跳过 LLM，仅用启发式排序 |

## 换乘推荐特性

- **全站搜索**：不限于大枢纽，探索所有可能的换乘站
- **同车换座**：自动检测同一车次分段购票（中途换座位）
- **智能排序**：LLM 理解自然语言偏好（「省钱」「最快」「带老人要舒适」）
- **过夜换乘**：正确处理次日凌晨的中转换乘时间
- **并发查询**：15 路并发请求 12306 API，容错设计

## 座位类型

| 缩写 | 含义 |
|------|------|
| swz | 商务座/特等座 |
| tz | 特等座 |
| zy | 一等座 |
| ze | 二等座 |
| rw | 软卧 |
| dw | 动卧 |
| yw | 硬卧 |
| yz | 硬座 |
| wz | 无座 |

## 输出格式

- **Markdown**（换乘推荐默认）：表格形式，适合终端/聊天
- **HTML**（直达查询默认）：Apple 风格页面，浏览器打开
- **JSON**：结构化数据，适合程序处理

## 数据来源

直接调用 12306 官方 API，无需任何 API Key。站点数据自动缓存 7 天。
