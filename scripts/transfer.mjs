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
