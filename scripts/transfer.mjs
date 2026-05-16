#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadStations, resolveStation } from './stations.mjs';

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
    help:           { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

const [fromName, toName] = positionals;
if (values.help || !fromName || !toName) {
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

// --- HTTP constants ---

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

// --- Time & utility helpers ---

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

function formatDurationStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
}

function hasSeat(val) {
  return val && val !== '--' && val !== '' && val !== '无';
}

// --- API ---

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

async function batchQuery(from, stations, travelDate, cookie, concurrency = 15) {
  const results = [];
  for (let i = 0; i < stations.length; i += concurrency) {
    const batch = stations.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (to) => {
        const tickets = await queryTickets(from, to, travelDate, cookie);
        return { toStation: to, tickets };
      })
    );
    let count = 0;
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.tickets.length > 0) {
        results.push(r.value);
        count++;
      } else if (r.status === 'rejected') {
        console.error(`  batch query failed: ${r.reason.message}`);
      }
    }
    console.error(`  batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(stations.length / concurrency)}: queried ${from.station_name} → ${batch.length} stations, ${count} returned results`);
  }
  return results;
}

// --- Candidate pool ---

function buildCandidatePool(origin, destination, stationMap) {
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

// --- Seat gathering ---

function gatherSeats(t) {
  return {
    swz: t.swz !== '--' ? t.swz : (t.tz !== '--' ? t.tz : '--'),
    zy: t.zy, ze: t.ze,
    rw: t.rw !== '--' ? t.rw : (t.dw !== '--' ? t.dw : '--'),
    yw: t.yw, yz: t.yz, wz: t.wz,
  };
}

// --- Layer 0: direct search ---

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
    totalDuration: t.duration && t.duration !== '--' ? durationMinutes(t.duration) : 0,
    transferCount: 0,
    transferStations: [],
    sameStationTransfer: null,
    sameTrainSeatChange: null,
    minTransferTime: 0,
    score: 0,
  }));
}

// --- BFS helper functions ---

function canConnect(prevArrive, nextDepart, minTransferMinutes) {
  let prev = parseTime(prevArrive);
  let next = parseTime(nextDepart);
  // If next departure is earlier in the day than prev arrival,
  // it must be the next calendar day — add 24h
  if (next < prev) next += 24 * 60;
  return next >= prev + minTransferMinutes;
}

function buildRoute(segments) {
  const transferStations = [];
  const minTransferTimes = [];
  let sameStation = true;
  let sameTrain = false;

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    transferStations.push(prev.toStation);
    let gap = parseTime(curr.departTime) - parseTime(prev.arriveTime);
    if (gap < 0) gap += 24 * 60; // overnight adjustment
    minTransferTimes.push(gap);
    if (prev.toCode !== curr.fromCode) sameStation = false;
    if (prev.trainCode === curr.trainCode) sameTrain = true;
  }

  // Compute total duration from first depart to last arrive, accounting for overnight
  const firstDepart = parseTime(segments[0].departTime);
  let lastArrive = parseTime(segments[segments.length - 1].arriveTime);
  if (lastArrive < firstDepart) lastArrive += 24 * 60;
  const totalDur = lastArrive - firstDepart;

  return {
    segments,
    totalDuration: totalDur,
    transferCount: segments.length - 1,
    transferStations,
    sameStationTransfer: transferStations.length > 0 ? sameStation : null,
    sameTrainSeatChange: transferStations.length > 0 ? sameTrain : null,
    minTransferTime: minTransferTimes.length > 0 ? Math.min(...minTransferTimes) : 0,
    score: 0,
  };
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

// --- BFS multi-layer transfer search ---

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

  // Collect all first-hop tickets with their arrival times
  const firstHopTickets = [];
  for (const { toStation, tickets } of firstHops) {
    for (const t1 of tickets) {
      firstHopTickets.push({ midStation: toStation, ticket: t1 });
    }
  }

  // Limit to top 50 by earliest arrival for performance
  const activeFirstHops = firstHopTickets
    .sort((a, b) => parseTime(a.ticket.arriveTime) - parseTime(b.ticket.arriveTime))
    .slice(0, 50);

  for (let i = 0; i < activeFirstHops.length; i++) {
    const { midStation, ticket: t1 } = activeFirstHops[i];
    if (i % 10 === 0) console.error(`  goal-directed ${i + 1}/${activeFirstHops.length}`);

    let destTickets = destResults.get(midStation.station_code);
    if (!destTickets) {
      destTickets = await queryTickets(midStation, destination, date, cookie);
      destResults.set(midStation.station_code, destTickets);
    }

    for (const t2 of destTickets) {
      if (canConnect(t1.arriveTime, t2.departTime, minTransferTime)) {
        allRoutes.push(buildRoute([
          wrapSegment(t1, origin.station_name, origin.station_code, midStation.station_name, midStation.station_code),
          wrapSegment(t2, midStation.station_name, midStation.station_code, destination.station_name, destination.station_code),
        ]));
      }
    }
  }

  console.error(`  Found ${allRoutes.length} total routes so far`);

  // Layer 2+: expand further if more transfers allowed
  if (maxTransfers >= 2) {
    console.error('Layer 2+: multi-transfer search');

    for (let h = 0; h < activeFirstHops.length && h < 15; h++) {
      const { midStation: hop1Station, ticket: t1 } = activeFirstHops[h];
      console.error(`  Layer 2 branch ${h + 1}/15: ${hop1Station.station_name}`);

      const secondHops = await batchQuery(hop1Station, candidatePool, date, cookie);

      // Limit second hops to top 10 by arrival time
      const activeSecondHops = secondHops
        .flatMap(hh => hh.tickets.map(t2 => ({ midStation2: hh.toStation, ticket: t2 })))
        .filter(hh => canConnect(t1.arriveTime, hh.ticket.departTime, minTransferTime))
        .filter(hh => hh.midStation2.station_code !== origin.station_code && hh.midStation2.station_code !== hop1Station.station_code)
        .sort((a, b) => parseTime(a.ticket.arriveTime) - parseTime(b.ticket.arriveTime))
        .slice(0, 10);

      for (const { midStation2, ticket: t2 } of activeSecondHops) {
        // Goal-directed: midStation2 → destination
        let destTickets = destResults.get(midStation2.station_code);
        if (!destTickets) {
          destTickets = await queryTickets(midStation2, destination, date, cookie);
          destResults.set(midStation2.station_code, destTickets);
        }

        for (const t3 of destTickets) {
          if (canConnect(t2.arriveTime, t3.departTime, minTransferTime)) {
            allRoutes.push(buildRoute([
              wrapSegment(t1, origin.station_name, origin.station_code, hop1Station.station_name, hop1Station.station_code),
              wrapSegment(t2, hop1Station.station_name, hop1Station.station_code, midStation2.station_name, midStation2.station_code),
              wrapSegment(t3, midStation2.station_name, midStation2.station_code, destination.station_name, destination.station_code),
            ]));
          }
        }

        // Layer 3: one more level
        if (maxTransfers >= 3) {
          const thirdHops = await batchQuery(midStation2, candidatePool, date, cookie);

          const activeThirdHops = thirdHops
            .flatMap(hh => hh.tickets.map(t3 => ({ midStation3: hh.toStation, ticket: t3 })))
            .filter(hh => canConnect(t2.arriveTime, hh.ticket.departTime, minTransferTime))
            .filter(hh => hh.midStation3.station_code !== origin.station_code
              && hh.midStation3.station_code !== hop1Station.station_code
              && hh.midStation3.station_code !== midStation2.station_code)
            .sort((a, b) => parseTime(a.ticket.arriveTime) - parseTime(b.ticket.arriveTime))
            .slice(0, 5);

          for (const { midStation3, ticket: t3 } of activeThirdHops) {
            let destTickets3 = destResults.get(midStation3.station_code);
            if (!destTickets3) {
              destTickets3 = await queryTickets(midStation3, destination, date, cookie);
              destResults.set(midStation3.station_code, destTickets3);
            }

            for (const t4 of destTickets3) {
              if (canConnect(t3.arriveTime, t4.departTime, minTransferTime)) {
                allRoutes.push(buildRoute([
                  wrapSegment(t1, origin.station_name, origin.station_code, hop1Station.station_name, hop1Station.station_code),
                  wrapSegment(t2, hop1Station.station_name, hop1Station.station_code, midStation2.station_name, midStation2.station_code),
                  wrapSegment(t3, midStation2.station_name, midStation2.station_code, midStation3.station_name, midStation3.station_code),
                  wrapSegment(t4, midStation3.station_name, midStation3.station_code, destination.station_name, destination.station_code),
                ]));
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

// --- Post-processing: dedup, filter, rank ---

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

function heuristicRank(routes) {
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
    if (r.minTransferTime > 0 && r.minTransferTime < 15) score -= 40;
    // Penalize long waits (more than 120 min)
    if (r.minTransferTime > 120) score -= 20;
    r.score = score;
  }

  return routes.sort((a, b) => b.score - a.score);
}

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
console.error(`Top routes:`);
for (let i = 0; i < Math.min(5, routes.length); i++) {
  const r = routes[i];
  console.error(`  #${i + 1}: ${r.segments.map(s => s.trainCode).join('→')} | ${formatDurationStr(r.totalDuration)} | ${r.transferCount} transfers | score: ${r.score.toFixed(1)}`);
}

// Output top 5 as JSON (temporary, full output formatting comes later)
console.log(JSON.stringify(routes.slice(0, 5), null, 2));
