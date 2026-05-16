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
