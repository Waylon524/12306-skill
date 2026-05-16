# AI 换乘推荐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `transfer.mjs` 脚本，BFS 搜索换乘路线 + OpenAI LLM 智能排序推荐

**Architecture:** 单文件 `scripts/transfer.mjs`，复用 `stations.mjs` 的站点数据和 `query.mjs` 的 API 调用模式。BFS 逐层搜索换乘路线，并发查询 12306 API，最后通过启发式 + LLM 两级排序输出推荐结果。

**Tech Stack:** Node.js >= 18, `openai` npm 包

---

### Task 1: 安装依赖 + 创建脚本骨架

**Files:**
- Create: `scripts/transfer.mjs`

- [ ] **Step 1: 安装 openai 包**

```bash
cd /Users/waylon524/Documents/WS/12306.skill && npm install openai
```

Expected: openai 包安装成功，`package.json` 新增依赖。

- [ ] **Step 2: 创建 transfer.mjs 骨架（参数解析 + 站点解析）**

```javascript
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStations, resolveStation } from './stations.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  options: {
    date:           { type: 'string', short: 'd' },
    'max-transfers': { type: 'string', default: '3' },
    'min-transfer': { type: 'string', default: '10' },
    preference:     { type: 'string' },
    type:           { type: 'string', short: 't', default: '' },
    seat:           { type: 'string' },
    format:         { type: 'string', short: 'f', default: 'md' },
    model:          { type: 'string', default: 'gpt-4o-mini' },
    'no-llm':       { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const [fromName, toName] = positionals;
if (!fromName || !toName) {
  console.error(`Usage: transfer.mjs <from> <to> [options]

Options:
  -d, --date <YYYY-MM-DD>       Travel date (default: today)
  --max-transfers <n>            Max transfers (default: 3)
  --min-transfer <minutes>       Min transfer time in minutes (default: 10)
  --preference <text>            User preference for LLM ranking
  -t, --type <G|D|Z|T|K>        Filter train types
  --seat <types>                 Seat type filter (comma-separated)
  -f, --format <md|html|json>    Output format (default: md)
  --model <name>                 OpenAI model (default: gpt-4o-mini)
  --no-llm                       Skip LLM ranking`);
  process.exit(1);
}

const date = values.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const maxTransfers = Math.min(parseInt(values['max-transfers']) || 3, 3);
const minTransferTime = parseInt(values['min-transfer']) || 10;
const trainTypeFilter = (values.type || '').toUpperCase();
const useLLM = !values['no-llm'];

// Station resolution
const stationData = await loadStations();
const fromStation = resolveStation(stationData, fromName);
const toStation = resolveStation(stationData, toName);
if (!fromStation) { console.error(`Station not found: ${fromName}`); process.exit(1); }
if (!toStation) { console.error(`Station not found: ${toName}`); process.exit(1); }

console.error(`Searching transfers: ${fromStation.station_name} → ${toStation.station_name} on ${date} (max ${maxTransfers} transfers, min ${minTransferTime}m)`);
```

- [ ] **Step 3: 运行骨架验证参数解析**

```bash
node scripts/transfer.mjs 北京 上海 --help 2>&1 || true
```

Expected: 显示 usage 信息。

- [ ] **Step 4: 测试站点解析**

```bash
node scripts/transfer.mjs 北京 上海 -f json --no-llm 2>&1 | head -5
```

Expected: stderr 显示 "Searching transfers: 北京 → 上海 on ..."，stdout 无输出（还没写搜索逻辑）。

- [ ] **Step 5: Commit**

```bash
git add scripts/transfer.mjs package.json package-lock.json
git commit -m "feat: scaffold transfer.mjs with argument parsing and station resolution"
```

---

### Task 2: API 查询层（复用 query.mjs 模式 + 并发控制）

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 在 transfer.mjs 中添加 HTTP 常量和工具函数**

在 station resolution 代码之后添加：

```javascript
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Referer: 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc',
};

const F = {
  trainNo: 2, trainCode: 3, fromCode: 6, toCode: 7,
  departTime: 8, arriveTime: 9, duration: 10, canBuy: 11, date: 13,
  gr: 21, rw: 23, rz: 24, tz: 25, wz: 26, yw: 28, yz: 29,
  ze: 30, zy: 31, swz: 32, dw: 33,
};

function parseTime(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function durationMinutes(raw) {
  const [h, m] = raw.split(':').map(Number);
  return h * 60 + m;
}

function formatDuration(raw) {
  const [h, m] = raw.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return raw;
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
}

function hasSeat(val) {
  return val && val !== '--' && val !== '' && val !== '无';
}
```

- [ ] **Step 2: 添加 cookie 获取和 API 查询函数**

```javascript
async function getCookie() {
  const res = await fetch('https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc', {
    headers: HEADERS,
    redirect: 'manual',
  });
  const cookies = res.headers.getSetCookie?.() || [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function queryTickets(from, to, travelDate, cookie) {
  const params = new URLSearchParams({
    'leftTicketDTO.train_date': travelDate,
    'leftTicketDTO.from_station': from.station_code,
    'leftTicketDTO.to_station': to.station_code,
    purpose_codes: 'ADULT',
  });

  const res = await fetch(`https://kyfw.12306.cn/otn/leftTicket/query?${params}`, {
    headers: { ...HEADERS, Cookie: cookie },
  });

  const json = await res.json();
  if (!json.data?.result) return [];
  return json.data.result.map(r => parseTicket(r, stationData.STATIONS));
}

function parseTicket(raw, stationMap) {
  const f = raw.split('|');
  const v = (key) => f[F[key]] || '--';
  return {
    trainNo: v('trainNo'), trainCode: v('trainCode'),
    fromStation: stationMap[v('fromCode')]?.station_name || v('fromCode'),
    toStation: stationMap[v('toCode')]?.station_name || v('toCode'),
    fromCode: v('fromCode'), toCode: v('toCode'),
    departTime: v('departTime'), arriveTime: v('arriveTime'),
    duration: v('duration'), canBuy: v('canBuy'), date: v('date'),
    swz: v('swz'), tz: v('tz'), zy: v('zy'), ze: v('ze'),
    gr: v('gr'), rw: v('rw'), dw: v('dw'),
    yw: v('yw'), rz: v('rz'), yz: v('yz'), wz: v('wz'),
  };
}
```

- [ ] **Step 3: 添加并发控制 + 批量查询函数**

```javascript
async function batchQuery(from, stations, travelDate, cookie, concurrency = 15) {
  const results = [];
  for (let i = 0; i < stations.length; i += concurrency) {
    const batch = stations.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (to) => {
        const tickets = await queryTickets(from, to, travelDate, cookie);
        return { toStation: to, tickets };
      })
    );
    for (const r of batchResults) {
      if (r.tickets.length > 0) results.push(r);
    }
    console.error(`  batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(stations.length / concurrency)}: queried ${from.station_name} → ${batch.length} stations, ${batchResults.filter(r => r.tickets.length > 0).length} returned results`);
  }
  return results;
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add 12306 API query layer with concurrency control"
```

---

### Task 3: 候选站池生成 + 直达搜索

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 添加候选站池构建函数**

用 station 数据中所有车站作为候选池（后续通过 BFS 自然剪枝）。按车次类型前缀过滤候选池中不相关的车站。

```javascript
function buildCandidatePool(origin, destination, allStations, stationMap) {
  // Include all stations as candidates, excluding origin and destination themselves
  const exclude = new Set([origin.station_code, destination.station_code]);
  const pool = [];
  for (const code of Object.keys(stationMap)) {
    if (!exclude.has(code)) {
      pool.push(stationMap[code]);
    }
  }
  return pool;
}
```

- [ ] **Step 2: 添加直达搜索（Layer 0）**

```javascript
async function searchDirect(origin, destination, date, cookie) {
  const tickets = await queryTickets(origin, destination, date, cookie);
  return tickets.map(t => ({
    segments: [{
      trainCode: t.trainCode, trainNo: t.trainNo,
      fromStation: t.fromStation, toStation: t.toStation,
      fromCode: t.fromCode, toCode: t.toCode,
      departTime: t.departTime, arriveTime: t.arriveTime,
      duration: t.duration, canBuy: t.canBuy,
      seats: gatherSeats(t),
    }],
    totalDuration: durationMinutes(t.duration),
    transferCount: 0,
    transferStations: [],
    sameStationTransfer: true,
    sameTrainSeatChange: false,
    minTransferTime: 0,
    score: 0,
  }));
}

function gatherSeats(t) {
  return {
    swz: t.swz !== '--' ? t.swz : (t.tz !== '--' ? t.tz : '--'),
    zy: t.zy, ze: t.ze,
    rw: t.rw !== '--' ? t.rw : (t.dw !== '--' ? t.dw : '--'),
    yw: t.yw, yz: t.yz, wz: t.wz,
  };
}
```

- [ ] **Step 3: 添加 Main 逻辑（仅 Layer 0 + 1 骨干测试）**

在文件末尾添加临时 main 逻辑：

```javascript
const cookie = await getCookie();
const candidatePool = buildCandidatePool(fromStation, toStation, stationData.STATIONS);
console.error(`Candidate pool: ${candidatePool.length} stations`);

// Layer 0: direct
const directs = await searchDirect(fromStation, toStation, date, cookie);
console.error(`Direct trains: ${directs.length}`);

// Layer 1: first hops from origin
const firstHops = await batchQuery(fromStation, candidatePool, date, cookie);
console.error(`First hops: ${firstHops.length} stations reachable from origin`);

console.log(JSON.stringify({ directs: directs.length, firstHops: firstHops.length }, null, 2));
```

- [ ] **Step 4: 运行测试（小范围）**

```bash
timeout 60 node scripts/transfer.mjs 北京 上海 -f json --no-llm 2>&1
```

Expected: 显示候选池大小、直达列车数、从北京出发可达车站数。可能需要一些时间。

- [ ] **Step 5: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add candidate pool generation and direct search"
```

---

### Task 4: BFS 换乘搜索（完整 1-3 层）

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 添加时间约束检查 + 路线构建辅助函数**

```javascript
function canConnect(prevArrive, nextDepart, minTransferMinutes) {
  return parseTime(nextDepart) >= parseTime(prevArrive) + minTransferMinutes;
}

function buildRoute(segments) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const totalDur = segments.reduce((sum, s) => sum + durationMinutes(s.duration), 0);
  const transferStations = [];
  const minTransferTimes = [];
  let sameStation = true;
  let sameTrain = false;

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    transferStations.push(prev.toStation);
    const gap = parseTime(curr.departTime) - parseTime(prev.arriveTime);
    minTransferTimes.push(gap);
    if (prev.toCode !== curr.fromCode) sameStation = false;
    if (prev.trainCode === curr.trainCode) sameTrain = true;
  }

  return {
    segments,
    totalDuration: totalDur,
    transferCount: segments.length - 1,
    transferStations,
    sameStationTransfer: sameStation,
    sameTrainSeatChange: sameTrain,
    minTransferTime: Math.min(...minTransferTimes),
    score: 0,
  };
}
```

- [ ] **Step 2: 添加 BFS 主搜索函数**

```javascript
async function bfsSearch(origin, destination, date, cookie, candidatePool, maxTransfers, minTransferTime) {
  const allRoutes = [];

  // Layer 0: direct trains
  console.error('Layer 0: direct search');
  const directs = await searchDirect(origin, destination, date, cookie);
  allRoutes.push(...directs);

  if (maxTransfers === 0) return allRoutes;

  // Layer 1: origin → candidate stations
  console.error(`Layer 1: origin → ${candidatePool.length} candidates`);
  const firstHops = await batchQuery(origin, candidatePool, date, cookie);
  console.error(`  ${firstHops.length} stations reachable from origin`);

  // For each first hop, try → destination (goal-directed)
  console.error('Layer 1: goal-directed (firstHop → destination)');
  const destResults = new Map(); // cache: station_code → tickets to dest

  for (let i = 0; i < firstHops.length; i++) {
    const { toStation, tickets } = firstHops[i];
    if (i % 50 === 0) console.error(`  goal-directed ${i + 1}/${firstHops.length}`);

    for (const t1 of tickets) {
      // Try toStation → dest
      let destTickets = destResults.get(toStation.station_code);
      if (!destTickets) {
        destTickets = await queryTickets(toStation, destination, date, cookie);
        destResults.set(toStation.station_code, destTickets);
      }

      for (const t2 of destTickets) {
        if (canConnect(t1.arriveTime, t2.departTime, minTransferTime)) {
          allRoutes.push(buildRoute([
            wrapSegment(t1, origin.station_name, origin.station_code, toStation.station_name, toStation.station_code),
            wrapSegment(t2, toStation.station_name, toStation.station_code, destination.station_name, destination.station_code),
          ]));
        }
      }
    }
  }

  console.error(`  Found ${allRoutes.length} total routes so far`);

  // Layer 2+: expand further if more transfers allowed
  if (maxTransfers >= 2) {
    console.error('Layer 2+: multi-transfer search');

    // Sort firstHops by arrival time, keep top 30 for deeper search
    const activeHops = firstHops
      .flatMap(h => h.tickets.map(t => ({ toStation: h.toStation, ticket: t, arrivalTime: t.arriveTime })))
      .sort((a, b) => parseTime(a.arrivalTime) - parseTime(b.arrivalTime))
      .slice(0, 30);

    for (let h = 0; h < activeHops.length; h++) {
      const hop1 = activeHops[h];
      console.error(`  Layer 2 branch ${h + 1}/${activeHops.length}: ${hop1.toStation.station_name}`);

      // Find next hops from hop1.toStation
      const secondHops = await batchQuery(hop1.toStation, candidatePool, date, cookie);

      for (const { toStation: midStation, tickets: t2List } of secondHops) {
        // Avoid loops: skip if midStation is origin or already visited
        if (midStation.station_code === origin.station_code) continue;
        if (midStation.station_code === hop1.toStation.station_code) continue;

        for (const t1 of [hop1.ticket]) {
          for (const t2 of t2List) {
            if (!canConnect(t1.arriveTime, t2.departTime, minTransferTime)) continue;

            // Goal-directed: midStation → destination
            let destTickets = destResults.get(midStation.station_code);
            if (!destTickets) {
              destTickets = await queryTickets(midStation, destination, date, cookie);
              destResults.set(midStation.station_code, destTickets);
            }

            for (const t3 of destTickets) {
              if (canConnect(t2.arriveTime, t3.departTime, minTransferTime)) {
                allRoutes.push(buildRoute([
                  wrapSegment(t1, origin.station_name, origin.station_code, hop1.toStation.station_name, hop1.toStation.station_code),
                  wrapSegment(t2, hop1.toStation.station_name, hop1.toStation.station_code, midStation.station_name, midStation.station_code),
                  wrapSegment(t3, midStation.station_name, midStation.station_code, destination.station_name, destination.station_code),
                ]));
              }
            }

            // Layer 3: expand one more level
            if (maxTransfers >= 3) {
              const thirdHops = await batchQuery(midStation, candidatePool, date, cookie);
              for (const { toStation: midStation2, tickets: t3List } of thirdHops) {
                if (midStation2.station_code === origin.station_code) continue;
                if (midStation2.station_code === hop1.toStation.station_code) continue;
                if (midStation2.station_code === midStation.station_code) continue;

                for (const t3 of t3List) {
                  if (!canConnect(t2.arriveTime, t3.departTime, minTransferTime)) continue;

                  let destTickets3 = destResults.get(midStation2.station_code);
                  if (!destTickets3) {
                    destTickets3 = await queryTickets(midStation2, destination, date, cookie);
                    destResults.set(midStation2.station_code, destTickets3);
                  }

                  for (const t4 of destTickets3) {
                    if (canConnect(t3.arriveTime, t4.departTime, minTransferTime)) {
                      allRoutes.push(buildRoute([
                        wrapSegment(t1, origin.station_name, origin.station_code, hop1.toStation.station_name, hop1.toStation.station_code),
                        wrapSegment(t2, hop1.toStation.station_name, hop1.toStation.station_code, midStation.station_name, midStation.station_code),
                        wrapSegment(t3, midStation.station_name, midStation.station_code, midStation2.station_name, midStation2.station_code),
                        wrapSegment(t4, midStation2.station_name, midStation2.station_code, destination.station_name, destination.station_code),
                      ]));
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  console.error(`Total routes found: ${allRoutes.length}`);
  return allRoutes;
}

function wrapSegment(t, fromName, fromCode, toName, toCode) {
  return {
    trainCode: t.trainCode, trainNo: t.trainNo,
    fromStation: fromName, fromCode,
    toStation: toName, toCode,
    departTime: t.departTime, arriveTime: t.arriveTime,
    duration: t.duration, canBuy: t.canBuy,
    seats: gatherSeats(t),
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add BFS transfer search with multi-layer expansion"
```

---

### Task 5: 去重 + 启发式排序 + 过滤

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 添加路线去重函数**

```javascript
function deduplicateRoutes(routes) {
  const seen = new Map();
  for (const route of routes) {
    // Key = station sequence (as codes)
    const key = route.segments.map(s => s.fromCode).join('-') + '-' + route.segments[route.segments.length - 1].toCode;
    const existing = seen.get(key);
    if (!existing || route.totalDuration < existing.totalDuration) {
      seen.set(key, route);
    }
  }
  return [...seen.values()];
}
```

- [ ] **Step 2: 添加车次类型和座位过滤**

```javascript
function applyFilters(routes, trainTypeFilter, seatFilter) {
  let result = routes;

  if (trainTypeFilter) {
    const chars = [...trainTypeFilter];
    result = result.filter(r =>
      r.segments.some(s => chars.some(ch => s.trainCode.startsWith(ch)))
    );
  }

  if (seatFilter) {
    const seatTypes = seatFilter.split(',').map(s => s.trim().toLowerCase());
    result = result.filter(r =>
      r.segments.every(s => seatTypes.every(st => hasSeat(s.seats[st])))
    );
  }

  return result;
}
```

- [ ] **Step 3: 添加启发式排序函数**

```javascript
function heuristicRank(routes) {
  // Score each route by weighted criteria
  for (const r of routes) {
    let score = 0;
    // Prefer fewer transfers
    score -= r.transferCount * 100;
    // Prefer shorter total duration
    score -= r.totalDuration * 0.5;
    // Prefer same-station transfer
    if (r.sameStationTransfer) score += 50;
    // Prefer same-train seat change
    if (r.sameTrainSeatChange) score += 80;
    // Prefer comfortable transfer time (20-60 min per transfer is ideal)
    if (r.minTransferTime >= 20 && r.minTransferTime <= 60) score += 30;
    // Penalize tight transfers (less than 15 min)
    if (r.minTransferTime < 15) score -= 40;
    // Penalize long waits (more than 120 min)
    if (r.minTransferTime > 120) score -= 20;
    r.score = score;
  }

  return routes.sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add route deduplication, filtering, and heuristic ranking"
```

---

### Task 6: LLM 集成（OpenAI 排序）

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 添加 LLM 排名函数**

```javascript
import OpenAI from 'openai';

async function llmRank(routes, preference, fromName, toName, travelDate, model) {
  const openai = new OpenAI(); // uses OPENAI_API_KEY from env

  const systemPrompt = `你是 12306 换乘推荐助手。根据用户偏好对候选路线排序，给出前 5 名推荐及简要理由。
偏好维度包括：总耗时、换乘次数、换乘时间充裕度、同站换乘、同车换座。`;

  const topN = routes.slice(0, 30); // Take top 30 for LLM

  // Build a compact version for LLM, with index mapping back to original routes
  const compactRoutes = topN.map((r, i) => ({
    idx: i,
    totalDuration: formatDurationStr(r.totalDuration),
    totalDurationMin: r.totalDuration,
    transferCount: r.transferCount,
    transferStations: r.transferStations,
    sameStationTransfer: r.sameStationTransfer,
    sameTrainSeatChange: r.sameTrainSeatChange,
    minTransferTime: r.minTransferTime,
    segments: r.segments.map(s => ({
      trainCode: s.trainCode,
      fromStation: s.fromStation,
      toStation: s.toStation,
      departTime: s.departTime,
      arriveTime: s.arriveTime,
      duration: s.duration,
      canBuy: s.canBuy,
      seats: s.seats,
    })),
  }));

  const userPrompt = `用户偏好: ${preference || '综合最优'}
出发: ${fromName} 到达: ${toName} 日期: ${travelDate}

候选路线 (JSON):
${JSON.stringify(compactRoutes, null, 2)}

请返回 JSON 数组（不要包含 markdown 代码块标记），按推荐度排序。数组中每项必须是候选路线中的一条（通过 idx 标识），并添加 "reason" 字段（中文推荐理由，一句话）。只返回前5名。格式：[{"idx": 0, "reason": "..."}, {"idx": 3, "reason": "..."}, ...]`;

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const text = response.choices[0].message.content.trim();
    // Strip markdown code fences if present
    const json = JSON.parse(text.replace(/^```json\s*/, '').replace(/```$/, ''));
    // Map LLM response (idx + reason) back to original route objects
    return json.map(item => ({
      ...topN[item.idx],
      reason: item.reason,
    }));
  } catch (err) {
    console.error(`LLM ranking failed: ${err.message}`);
    return null;
  }
}

function formatDurationStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
}
```

- [ ] **Step 2: 集成 LLM 到 Main 流程**

替换文件末尾的 Main 部分：

```javascript
// --- Main ---

const cookie = await getCookie();
const candidatePool = buildCandidatePool(fromStation, toStation, stationData.STATIONS);
console.error(`Candidate pool: ${candidatePool.length} stations`);

let routes = await bfsSearch(fromStation, toStation, date, cookie, candidatePool, maxTransfers, minTransferTime);
console.error(`Total routes before dedup: ${routes.length}`);

routes = deduplicateRoutes(routes);
console.error(`After dedup: ${routes.length}`);

routes = applyFilters(routes, trainTypeFilter, values.seat || '');
console.error(`After filters: ${routes.length}`);

routes = heuristicRank(routes);

let finalResults;
if (useLLM && routes.length > 0) {
  console.error('Calling LLM for ranking...');
  const llmResults = await llmRank(
    routes,
    values.preference || '',
    fromStation.station_name,
    toStation.station_name,
    date,
    values.model
  );

  if (llmResults) {
    finalResults = llmResults;
  } else {
    console.error('LLM failed, falling back to heuristic ranking');
    finalResults = heuristicRoutesToOutput(routes.slice(0, 5));
  }
} else {
  finalResults = heuristicRoutesToOutput(routes.slice(0, 5));
}

function heuristicRoutesToOutput(routes) {
  return routes.map(r => ({
    ...r,
    reason: '（未使用 AI 排序）',
    segments: r.segments,
  }));
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add LLM ranking integration with OpenAI"
```

---

### Task 7: Markdown 输出

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 添加 Markdown 输出函数**

```javascript
function buildMarkdown(results, fromName, toName, travelDate, preference) {
  const lines = [];
  lines.push(`## ${fromName} → ${toName} | ${travelDate} | 换乘推荐`);
  lines.push('');
  if (preference) lines.push(`偏好：${preference}`);
  lines.push('');
  lines.push('| # | 方案 | 总耗时 | 换乘 | 换乘站 | 详情 | 状态 | 推荐理由 |');
  lines.push('|---|------|--------|------|--------|------|------|----------|');

  let idx = 1;
  for (const r of results) {
    const trainChain = r.segments.map(s => s.trainCode).join('→');
    const transfers = r.transferCount === 0 ? '直达' : `${r.transferCount}次`;
    const transferStations = r.transferStations.join('→') || '—';
    const timeRange = `${r.segments[0].departTime}-${r.segments[r.segments.length - 1].arriveTime}`;
    const buyStatus = r.segments.every(s => s.canBuy === 'Y') ? '✅' : '⚠';
    const reason = r.reason || '';
    lines.push(`| ${idx} | ${trainChain} | ${formatDurationStr(r.totalDuration)} | ${transfers} | ${transferStations} | ${timeRange} | ${buyStatus} | ${reason} |`);
    idx++;

    // Highlight same-train seat change
    if (r.sameTrainSeatChange) {
      lines.push(`| | 💡 **同车换座**：${r.segments[0].trainCode} 在 ${r.transferStations.join('、')} 换座位即可 | | | | | | |`);
    }
  }

  lines.push('');
  lines.push(`⚠ 数据来源 12306 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  return lines.join('\n');
}
```

- [ ] **Step 2: 接入 Main 输出**

在 Main 末尾替换输出逻辑：

```javascript
const fmt = values.format?.toLowerCase() || 'md';

if (fmt === 'json') {
  console.log(JSON.stringify(finalResults, null, 2));
} else if (fmt === 'md') {
  console.error(`\n${finalResults.length} recommendations.`);
  console.log(buildMarkdown(finalResults, fromStation.station_name, toStation.station_name, date, values.preference));
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add markdown output for transfer recommendations"
```

---

### Task 8: JSON 输出 + 最终集成

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 完善 JSON 输出**

JSON 格式已在 Main 中处理（`JSON.stringify(finalResults, null, 2)`），确认 finalResults 结构包含所有必要字段。

- [ ] **Step 2: 修正 finalResults 输出格式，确保 LLM 返回和 heuristic 返回格式一致**

在 Main 中统一处理输出格式：

```javascript
const fmt = values.format?.toLowerCase() || 'md';

if (fmt === 'json') {
  // Output raw search result with all routes
  const output = {
    from: fromStation.station_name,
    to: toStation.station_name,
    date,
    totalRoutes: routes.length,
    recommendations: finalResults.slice(0, 5),
  };
  console.log(JSON.stringify(output, null, 2));
} else if (fmt === 'md') {
  console.error(`\n${finalResults.length} recommendations.`);
  console.log(buildMarkdown(finalResults, fromStation.station_name, toStation.station_name, date, values.preference));
} else if (fmt === 'html') {
  // HTML output — reuse query.mjs style, adapt for multi-segment display
  const html = buildHTML(finalResults, fromStation, toStation, date, values.preference);
  const outPath = join(__dirname, '..', 'data',
    `transfer-${fromStation.station_name}-${toStation.station_name}-${date}.html`);
  writeFileSync(outPath, html);
  console.error(`Saved to ${outPath}`);
  console.log(outPath);
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add JSON output and finalize output formatting"
```

---

### Task 9: HTML 输出（Apple 风格，多段展示）

**Files:**
- Modify: `scripts/transfer.mjs`

- [ ] **Step 1: 添加 HTML 输出函数**

```javascript
function buildHTML(results, from, to, travelDate, preference) {
  const e = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fn = e(from.station_name), tn = e(to.station_name);

  const rows = results.map((r, idx) => {
    const segmentsHTML = r.segments.map((s, si) => `
      <div class="segment">
        <span class="train-code type-${s.trainCode[0]?.toLowerCase() || ''}">${e(s.trainCode)}</span>
        <span class="sta">${e(s.fromStation)}</span>
        <span class="time depart">${e(s.departTime)}</span>
        <span class="arrow">→</span>
        <span class="time arrive">${e(s.arriveTime)}</span>
        <span class="sta">${e(s.toStation)}</span>
        <span class="dur">${e(s.duration)}</span>
        ${si < r.segments.length - 1 ? `<div class="transfer-gap">⏱ 换乘 ${r.transferStations[si] ? e(r.transferStations[si]) : ''} · ${r.minTransferTime}分钟</div>` : ''}
      </div>`).join('');

    const tags = [];
    if (r.sameTrainSeatChange) tags.push('<span class="tag tag-train">同车换座</span>');
    if (r.sameStationTransfer && r.transferCount > 0) tags.push('<span class="tag tag-station">同站换乘</span>');
    if (r.transferCount === 0) tags.push('<span class="tag tag-direct">直达</span>');

    return `
    <div class="route-card">
      <div class="route-header">
        <span class="route-rank">#${idx + 1}</span>
        <span class="route-summary">总耗时 ${formatDurationStr(r.totalDuration)} · ${r.transferCount === 0 ? '直达' : r.transferCount + '次换乘'}</span>
        <span class="route-tags">${tags.join('')}</span>
      </div>
      <div class="route-segments">${segmentsHTML}</div>
      <div class="route-reason">💬 ${e(r.reason || '')}</div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fn} → ${tn} 换乘推荐</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; background: #f5f5f7; color: #1d1d1f; }
  .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
  header { text-align: center; margin-bottom: 32px; }
  h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.5px; }
  h1 .arrow { margin: 0 12px; color: #86868b; font-weight: 300; }
  .meta { margin-top: 8px; color: #86868b; font-size: 15px; }
  .pref { display: inline-block; margin-top: 8px; background: #0071e3; color: #fff; padding: 2px 12px; border-radius: 20px; font-size: 13px; }
  .route-card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .route-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #f0f0f0; }
  .route-rank { background: #0071e3; color: #fff; width: 28px; height: 28px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; }
  .route-summary { font-weight: 600; font-size: 15px; }
  .route-tags { margin-left: auto; display: flex; gap: 6px; }
  .tag { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .tag-train { background: #fff3e0; color: #e65100; }
  .tag-station { background: #e8f5e9; color: #2e7d32; }
  .tag-direct { background: #e3f2fd; color: #1565c0; }
  .segment { padding: 6px 0; display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .train-code { font-weight: 600; min-width: 50px; }
  .type-g { color: #0071e3; }
  .type-d { color: #34c759; }
  .type-z { color: #af52de; }
  .type-t { color: #ff9500; }
  .type-k { color: #86868b; }
  .sta { color: #6e6e73; min-width: 60px; }
  .time { font-variant-numeric: tabular-nums; }
  .depart { font-weight: 600; }
  .arrive { color: #6e6e73; }
  .arrow { color: #c0c0c0; margin: 0 4px; }
  .dur { color: #86868b; font-size: 13px; }
  .transfer-gap { width: 100%; padding: 4px 0 4px 58px; color: #ff9500; font-size: 12px; }
  .route-reason { margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f0; color: #6e6e73; font-size: 13px; }
  .empty { padding: 60px 20px; text-align: center; color: #86868b; font-size: 15px; }
  footer { text-align: center; margin-top: 24px; color: #c0c0c0; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${fn}<span class="arrow">→</span>${tn}</h1>
    <div class="meta">${e(travelDate)} · 换乘推荐 · ${results.length} 个方案</div>
    ${preference ? `<div class="pref">${e(preference)}</div>` : ''}
  </header>
  ${results.length === 0
    ? '<div class="empty">未找到符合条件的换乘方案</div>'
    : rows}
  <footer>数据来源 12306 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</footer>
</div>
</body>
</html>`;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/transfer.mjs
git commit -m "feat: add HTML output with Apple-style multi-segment display"
```

---

### Task 10: 更新 SKILL.md

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: 在 SKILL.md 的 Query Tickets 部分之后添加 Transfer 章节**

在 `## Important Notes` 之前插入：

```markdown
## AI Transfer Search

```bash
node {baseDir}/scripts/transfer.mjs <from> <to> [options]
```

AI-powered transfer recommendation: BFS searches all possible transfer stations, LLM ranks results by user preference.

### Examples

```bash
# Basic transfer search (default up to 3 transfers)
node {baseDir}/scripts/transfer.mjs 北京 上海

# With preference for LLM ranking
node {baseDir}/scripts/transfer.mjs 北京 广州 --preference "省钱优先"

# Limit to 1 transfer, minimum 20min transfer time
node {baseDir}/scripts/transfer.mjs 北京 深圳 --max-transfers 1 --min-transfer 20

# Skip LLM, heuristic ranking only
node {baseDir}/scripts/transfer.mjs 武汉 上海 --no-llm

# JSON output for programmatic use
node {baseDir}/scripts/transfer.mjs 成都 重庆 --json
```

### Options

- `-d, --date <YYYY-MM-DD>`: Travel date (default: today)
- `--max-transfers <n>`: Max transfers (default: 3, max 3)
- `--min-transfer <minutes>`: Min transfer time in minutes (default: 10)
- `--preference <text>`: User preference for LLM ranking (e.g., "省钱优先", "最快到达", "带老人要舒适")
- `-t, --type <G|D|Z|T|K>`: Filter train types
- `--seat <types>`: Seat type filter (comma-separated)
- `-f, --format <md|html|json>`: Output format (default: md)
- `--model <name>`: OpenAI model (default: gpt-4o-mini)
- `--no-llm`: Skip LLM, use heuristic ranking only

### Features

- **BFS search**: Explores all stations, not just major hubs
- **Same-train seat change**: Automatically detects when buying two segments of the same train works better than a transfer
- **LLM ranking**: Understands natural language preferences like "省钱", "最快", "舒适"
- **Multi-transfer**: Supports up to 3 transfers
- **Requires**: `OPENAI_API_KEY` environment variable (for LLM ranking)
```

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "docs: add AI transfer search section to SKILL.md"
```

---

### Task 11: 端到端验证

**Files:**
- Modify: `scripts/transfer.mjs` (如有修复)

- [ ] **Step 1: 测试直达场景（已知有结果的路线）**

```bash
node scripts/transfer.mjs 北京 上海 -f md --no-llm 2>&1 | head -20
```

Expected: 显示北京→上海换乘推荐表格，包含直达和换乘方案。

- [ ] **Step 2: 测试 JSON 输出**

```bash
node scripts/transfer.mjs 北京 南京 --json --no-llm 2>&1 | head -30
```

Expected: JSON 格式输出，包含 routes 和 recommendations。

- [ ] **Step 3: 测试参数过滤**

```bash
node scripts/transfer.mjs 北京 上海 -t G --max-transfers 1 --no-llm -f md 2>&1 | head -15
```

Expected: 仅显示 G 字头、最多 1 次换乘的方案。

- [ ] **Step 4: 验证 LLM 集成（如有 API key）**

```bash
OPENAI_API_KEY=sk-xxx node scripts/transfer.mjs 北京 广州 --preference "最快到达" -f md 2>&1
```

Expected: LLM 排序后显示推荐理由。

- [ ] **Step 5: 修复发现的问题，然后 commit**

```bash
git add scripts/transfer.mjs
git commit -m "fix: end-to-end validation fixes"
```
