import { BEAM_MODES, defaultGroups, dotted, isExtensionText, measureTable, meterLength, newScore, openScore, pitchAtSound, QUARTER, sound, TEMPO_UNITS, tick, tickEnd, VALUES } from './score.js';
import { appearanceKey } from './engrave.js';
import { notation } from './notation.js';
import type { BeamMode, Ending, ExtensionTextField, GraceGroup, GraceNote, ImportNotice, KeySignature, Lane, Measure, Meter, Note, Pitch, Score, TempoLine, TempoLineKind, TempoMark } from './score.js';
import type { DynamicStep } from './score.js';
import { scoreTempoAt, TEMPO_PRESETS } from './tempo.js';
import { chordKinds, degreeForNote, noteForDegree, parseChord } from './chord-symbol.js';
import type { ChordSymbol } from './chord-symbol.js';
import type { RouteMark, RouteKind } from './roadmap.js';

const LIMIT = 10_000_000;
const steps = 'CDEFGAB';
const scale = [0, 2, 4, 5, 7, 9, 11];
const values: Record<string, number> = { whole: 384, half: 192, quarter: 96, eighth: 48, '16th': 24, '32nd': 12, '64th': 6, '128th': 3 };
const nodes = (element: Element | undefined, name: string) => Array.from(element?.children ?? []).filter(child => child.localName === name);
const node = (element: Element | undefined, name: string) => nodes(element, name)[0];
const value = (element: Element | undefined, name: string) => element && node(element, name)?.textContent?.trim();
const mod = (number: number, base: number) => (number % base + base) % base;
const validTempo = (rate: number) => Number.isFinite(rate) && rate > 0 && rate <= 1200;
const tempoWord = (text: string) => Object.entries(TEMPO_PRESETS).find(([name]) => name.toLowerCase() === text.trim().toLowerCase())?.[1];
function tempoLineWord(text: string): TempoLineKind | undefined {
  if (/^accel(?:\.|erando)?$/i.test(text)) return 'accel.';
  if (/^rit(?:\.|ardando)?$/i.test(text)) return 'rit.';
  if (/^rall(?:\.|entando)?$/i.test(text)) return 'rall.';
  if (/^allarg(?:\.|ando)?$/i.test(text)) return 'allarg.';
}
function xml(source: string) {
  if (/<!ENTITY/i.test(source)) throw Error('不支持 XML 实体定义。');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw Error('无法读取 XML，请确认文件完整。');
  return document.documentElement;
}

export async function readMusicFile(file: File) {
  if (file.size > LIMIT) throw Error('乐谱文件超过 10 MB。');
  if (!/\.mxl$/i.test(file.name)) return file.text();
  const data = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(data.buffer);
  const long = (at: number) => view.getUint32(at, true);
  const short = (at: number) => view.getUint16(at, true);
  const decoder = new TextDecoder();
  let footer = data.length - 22;
  while (footer >= Math.max(0, data.length - 65557) && (long(footer) !== 0x06054b50 || footer + 22 + short(footer + 20) !== data.length)) footer--;
  if (footer < Math.max(0, data.length - 65557) || short(footer + 4) || short(footer + 6))
    throw Error('无效的 MXL 压缩包。');
  const entries = new Map<string, { method: number; compressed: number; size: number; offset: number; flags: number }>();
  let at = long(footer + 16);
  const count = short(footer + 10);
  if (count > 500 || short(footer + 8) !== count) throw Error('不支持此 MXL 压缩包结构。');
  for (let index = 0; index < count; index++) {
    if (at + 46 > footer || long(at) !== 0x02014b50) throw Error('MXL 目录损坏。');
    const length = short(at + 28);
    const next = at + 46 + length + short(at + 30) + short(at + 32);
    if (next > footer) throw Error('MXL 目录损坏。');
    entries.set(decoder.decode(data.subarray(at + 46, at + 46 + length)), {
      method: short(at + 10), flags: short(at + 8), compressed: long(at + 20), size: long(at + 24), offset: long(at + 42)
    });
    at = next;
  }
  async function extract(name: string) {
    const item = entries.get(name);
    if (!item || item.size > LIMIT || item.flags & 1 || item.offset + 30 > footer || long(item.offset) !== 0x04034b50)
      throw Error('无法读取 MXL 内的 ' + name);
    const start = item.offset + 30 + short(item.offset + 26) + short(item.offset + 28);
    if (start + item.compressed > footer) throw Error('MXL 数据不完整。');
    const bytes = data.slice(start, start + item.compressed);
    if (item.method === 0 && bytes.length === item.size) return decoder.decode(bytes);
    if (item.method !== 8) throw Error('不支持此 MXL 文件的压缩方式。');
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const output = new Uint8Array(item.size);
    let written = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (written + chunk.value.length > item.size) { await reader.cancel(); throw Error('MXL 解压大小异常。'); }
      output.set(chunk.value, written);
      written += chunk.value.length;
    }
    if (written !== item.size) throw Error('MXL 解压大小异常。');
    return decoder.decode(output);
  }
  const manifest = xml(await extract('META-INF/container.xml'));
  const root = node(node(manifest, 'rootfiles'), 'rootfile')?.getAttribute('full-path');
  if (!root) throw Error('MXL 没有指定主乐谱。');
  return extract(root);
}

type ParsedNote = Note;
export interface ImportResult { score: Score; warnings: ImportNotice[] }

function spell(midi: number, step: number, fifths: number, tonic: number): Pitch {
  const degree = mod(step - fifths * 4, 7);
  const base = tonic + scale[degree];
  const octave = Math.round((midi - base) / 12) - 1;
  const alter = midi - base - (octave + 1) * 12;
  return Math.abs(alter) <= 2 ? { degree: degree + 1, octave, alter } : pitchAtSound(midi, tonic);
}

function measureEvidence(part: Element) {
  let divisions = 1;
  return nodes(part, 'measure').map(measure => {
    let position = 0, end = 0, count = 0, wholeRest = false;
    for (const item of Array.from(measure.children)) {
      if (item.localName === 'attributes') {
        divisions = Number(value(item, 'divisions') ?? divisions);
        continue;
      }
      const duration = Number(value(item, 'duration') ?? 0) * QUARTER / divisions;
      if (item.localName === 'backup' || item.localName === 'forward') {
        position += item.localName === 'forward' ? duration : -duration;
        if (item.localName === 'forward') count++;
      } else if (item.localName === 'note' && !node(item, 'grace') && !node(item, 'chord')) {
        wholeRest ||= position === 0 && node(item, 'rest')?.getAttribute('measure') === 'yes';
        count++;
        position += duration;
      }
      end = Math.max(end, position);
    }
    return { end: tick(end), placeholder: count === 1 && wholeRest, implicit: measure.getAttribute('implicit') === 'yes' };
  });
}

function actualMeterFromLength(length: number, printed: Meter): Meter | undefined {
  for (const denominator of [printed.denominator, 4, 8, 16, 2]) {
    const numerator = length * denominator / (4 * QUARTER);
    if (Number.isInteger(numerator) && numerator >= 1 && numerator <= 16)
      return { numerator, denominator, groups: defaultGroups(numerator, denominator) };
  }
}

export function importMusicXML(source: string, name: string, preserveBeams = false): ImportResult {
  const root = xml(source);
  if (root.localName !== 'score-partwise') throw Error('目前只支持分声部排列的 MusicXML（score-partwise）。');
  const parts = nodes(root, 'part');
  if (!parts.length || parts.length > 32) throw Error('声部数量超出支持范围。');
  const evidence = parts.map(measureEvidence);
  const measureCount = evidence[0].length;
  if (!measureCount || measureCount > 600 || evidence.some(part => part.length !== measureCount))
    throw Error('小节数量与总谱不一致，无法安全对齐。');
  const score = newScore();
  score.title = (value(root, 'movement-title') || value(node(root, 'work'), 'work-title') || name.replace(/\.(musicxml|xml|mxl)$/i, '')).slice(0, 100);
  const creators = nodes(node(root, 'identification') ?? root, 'creator');
  score.credit = creators.filter(item => !['lyricist', 'arranger', 'composer'].includes(item.getAttribute('type') ?? ''))
    .map(item => item.textContent?.trim()).filter(Boolean).join(' · ').slice(0, 100);
  score.lyricist = creators.find(item => item.getAttribute('type') === 'lyricist')?.textContent?.trim().slice(0, 100);
  score.composer = creators.find(item => item.getAttribute('type') === 'composer')?.textContent?.trim().slice(0, 100);
  score.copyright = value(node(root, 'identification'), 'rights')?.slice(0, 300);
  score.arranger = creators.find(item => item.getAttribute('type') === 'arranger')?.textContent?.trim().slice(0, 100);
  score.subtitle = value(nodes(root, 'credit').find(credit => value(credit, 'credit-type') === 'subtitle'), 'credit-words')?.slice(0, 100);
  score.measures = [];
  score.lanes = [];
  const warnings = new Set<string>();
  const locatedNotices: ImportNotice[] = [];
  const locations = new Map<string, { lane: string; measure: number }>();
  let openEnding: Omit<Ending, 'end'> | undefined;
  const names = new Map(Array.from(node(root, 'part-list')?.children ?? [])
    .map(item => [item.getAttribute('id'), item]));
  const fields = nodes(node(node(root, 'identification'), 'miscellaneous') ?? root, 'miscellaneous-field');
  const projectMetadata = (name: string) => (fields.find(node => node.getAttribute('name') === 'shupu-' + name) ??
    fields.find(node => node.getAttribute('name') === 'choral-jianpu-' + name))?.textContent;
  const metadata = projectMetadata('bar-settings');
  const chordMetadata = projectMetadata('chord-labels');
  let chordLabels: Record<string, { text?: string; actual?: string }> = {};
  if (chordMetadata && chordMetadata.length < 4_000_000) try { chordLabels = JSON.parse(chordMetadata) ?? {}; } catch {}
  const tempoMetadata = projectMetadata('tempo');
  const tempoLineWords = new Map<number, Set<string>>();
  if (tempoMetadata) try {
    const lines = JSON.parse(tempoMetadata)?.lines;
    if (Array.isArray(lines)) for (const line of lines) if (line && Number.isFinite(line.from)) {
      const label = String(line.label ?? line.kind ?? '').trim().slice(0, 80);
      if (label) {
        let labels = tempoLineWords.get(line.from);
        if (!labels) tempoLineWords.set(line.from, labels = new Set());
        labels.add(label);
      }
    }
  } catch {}
  const isTempoLineWord = (at: number, caption: string) => {
    const labels = tempoLineWords.get(at);
    return !!labels && [...labels].some(label => label === caption || !caption.split(label).join('').trim());
  };
  let barSettings: Record<number, { meter?: Meter; pickup?: boolean; firstKey?: boolean; firstMeter?: boolean; titleSignatures?: Score['titleSignatures'] }> = {};
  if (metadata && metadata.length < 100000) try { barSettings = JSON.parse(metadata) ?? {}; } catch {}
  const tempos = new Map<number, { mark: TempoMark; rank: number }>();
  const swingMarks = new Map<number, TempoMark>();
  const readSwing = (sound: Element | undefined, at: number, caption = '') => {
    const swing = node(sound, 'swing');
    if (at < 0 || !swing && !/^(swing|straight)$/i.test(caption)) return false;
    if (swingMarks.has(at)) return true;
    const straight = !!node(swing, 'straight') || /^straight$/i.test(caption);
    const ratio = swing ? Number(value(swing, 'first')) / Number(value(swing, 'second')) : 2;
    if (!straight && (!Number.isFinite(ratio) || ratio < 1 || ratio > 4)) return false;
    swingMarks.set(at, { id: 'xml-swing-' + at, at, kind: straight ? 'straight' : 'swing',
      swingUnit: value(swing, 'swing-type') === '16th' ? 24 : 48, ratio: straight ? 1 : ratio, label: caption || undefined,
      appearance: caption ? undefined : { visible: false, layout: false } });
    return true;
  };
  const routes = new Map<number, RouteMark[]>();
  const inferredRoutes = new Set<string>();
  let repeatsAfterJump = false;
  const readRoute = (index: number, item: Element, sound?: Element, marks: Element[] = [], caption = '') => {
    const id = item.getAttribute('id') ?? '';
    const attributes: [string, RouteKind][] = [['segno','segno'], ['coda','coda'], ['dacapo','dc'],
      ['dalsegno','ds'], ['tocoda','tocoda'], ['fine','fine']];
    let used = false;
    for (const [attribute, kind] of attributes) {
      const target = sound?.getAttribute(attribute) || (marks.some(mark => mark.localName === kind) ? '1' : '');
      if (!target) continue;
      const mark: RouteMark = { id: `xml-route-${++serial}`, kind, target: target === 'yes' ? '1' : target.slice(0, 40) };
      if (kind === 'dc' || kind === 'ds') {
        mark.until = /al\s+fine/i.test(caption) ? 'fine' : /al\s+coda/i.test(caption) ? 'coda' : undefined;
        mark.repeat = id.startsWith('cj-route-again-') ? true : id.startsWith('cj-route-once-') ? false : undefined;
        if (!id.startsWith('cj-route-') && !mark.until) inferredRoutes.add(mark.id);
      }
      let list = routes.get(index);
      if (!list) { list = []; routes.set(index, list); }
      if (!list.some(other => other.kind === mark.kind && other.target === mark.target) && list.length < 30) list.push(mark);
      used = true;
    }
    return used;
  };
  const tempoLines = new Map<number, TempoLine>();
  const writeTempo = (mark: TempoMark, rank: number) => {
    if (mark.at >= 0 && (tempos.get(mark.at)?.rank ?? -Infinity) < rank) tempos.set(mark.at, { mark, rank });
  };
  let serial = 0;
  type ExtensionDirection = { at: number; track: string; field: ExtensionTextField; right: boolean; caption: string; where: string };
  const extensionDirections: (ExtensionDirection & { lane: string })[] = [];
  type ParsedGroup = { start: number; finish: number; count: number; unit: number; scale: number; localScale?: number; hidden?: boolean };
  for (const [partIndex, part] of parts.entries()) {
    const info = names.get(part.getAttribute('id'));
    const name = value(info, 'part-name') || `声部 ${partIndex + 1}`;
    const measures = nodes(part, 'measure');
    if (!measures.length || measures.length > 600 || (partIndex && measures.length !== score.measures.length))
      throw Error(name + '：小节数量与总谱不一致，无法安全对齐。');
    const head = `xml-${partIndex}`;
    const main: Lane = { id: head, name: name.slice(0, 80), shortName: value(info, 'part-abbreviation')?.slice(0, 40), octave: 4 };
    const chordDirections: (Omit<ChordSymbol, 'lane'> & { track: string; hidden: boolean; where: string })[] = [];
    const unresolved: { text: string; measure: number; offset: number; track: string }[] = [];
    score.lanes.push(main);
    const lanes = new Map<string, ParsedNote[]>();
    const ties = new Map<string, { note: ParsedNote; pitch: number }>();
    const slurs = new Map<string, ParsedNote>();
    const slides = new Map<string, { note: ParsedNote; pitch: number }>();
    const tremolos = new Map<string, ParsedNote>();
    type GradualDynamic = { kind: 'crescendo' | 'diminuendo'; track: string; where: string; dynamicText?: string; dynamicTarget?: DynamicStep };
    const wedges = new Map<string, GradualDynamic & { at: number }>();
    const directions: { at: number; track: string; dynamic?: string; text?: string; rehearsal?: string; where: string }[] = [];
    const taggedDirections: ExtensionDirection[] = [];
    const openTuplets = new Map<string, Omit<ParsedGroup, 'finish'>>();
    const pendingGrace = new Map<string, GraceGroup>();
    const graceLinks = new WeakMap<GraceGroup, Map<string, { event: string; pitch: number }>>();
    const lastPrincipal = new Map<string, ParsedNote>();
    const trackTuplets = new Map<string, ParsedGroup[]>();
    const modified = new Map<string, { scale: number; count: number; unit: number }>();
    const wedgeEnds: (GradualDynamic & { start: number; end: number })[] = [];
    const tempoDashes = new Map<string, { from: number; kind: TempoLineKind; label: string }>();
    let mainTrack = '';
    let at = 0;
    let divisions = 1;
    let fifths = 0;
    let meter: Meter = { numerator: 4, denominator: 4, groups: [1, 1, 1, 1] };
    for (const [index, measure] of measures.entries()) {
      const number = measure.getAttribute('number') ?? String(index + 1);
      const where = `${name} · 第 ${number} 小节`;
      locations.set(where, { lane: head, measure: index });
      const fail = (issue: string): never => { throw Error(where + '：' + issue); };
      let itemOffset = 0, itemTrack = '';
      const warn = (issue: string) => {
        if (!unresolved.some(entry => entry.measure === index && entry.text === where + '：' + issue && entry.track === itemTrack &&
          entry.offset === itemOffset))
          unresolved.push({ measure: index, offset: Math.max(0, tick(itemOffset)), text: where + '：' + issue, track: itemTrack });
      };
      const ticks = (duration: string | undefined, rhythm = true) => {
        const result = Number(duration ?? 0) * QUARTER / divisions;
        if (!Number.isFinite(result) || rhythm && result < 0) fail('此位置的时值无效。');
        return result;
      };
      let position = 0;
      let greatest = 0;
      let last: ParsedNote | undefined;
      let lastTrack = '';
      let meterChange: Meter | undefined;
      let tonicChange: number | undefined;
      let keyChange: KeySignature | undefined;
      let meterHidden = false, keyHidden = false;
      const occupied = evidence.map(part => part[index]);
      const active = occupied.filter(part => !part.placeholder && Number.isFinite(part.end) && part.end > 0);
      const endpoints = [...new Set(active.map(part => part.end))];
      const restEnds = endpoints.length ? [] : [...new Set(occupied.filter(part => part.placeholder && Number.isFinite(part.end) && part.end > 0).map(part => part.end))];
      const longest = Math.max(0, ...endpoints);
      const implicit = occupied.some(item => item.implicit) || index === 0 && number === '0';
      const inferred = endpoints.length === 1 || implicit && longest ? longest : restEnds.length === 1 ? restEnds[0] : undefined;
      const beamGroups = new Map<string, number>();
      for (const item of Array.from(measure.children)) {
        itemOffset = position;
        itemTrack = (value(item, 'staff') ?? '1') + '/' + (value(item, 'voice') ?? '1');
        switch (item.localName) {
          case 'attributes': {
            const unit = value(item, 'divisions');
            if (unit) {
              divisions = Number(unit);
              if (!Number.isInteger(divisions) || divisions <= 0) fail('不合法的 divisions。');
            }
            if (node(item, 'transpose')) fail('暂不支持移调乐器。');
            const key = node(item, 'key');
            if (key) {
              if (position || nodes(item, 'key').length > 1 || value(key, 'fifths') === undefined)
                fail('暂不支持小节内转调或非传统调号。');
              fifths = Number(value(key, 'fifths'));
              if (!Number.isInteger(fifths) || Math.abs(fifths) > 7) fail('无效的调号。');
              tonicChange = mod(fifths * 7, 12);
              keyChange = { fifths, degree: value(key, 'mode') === 'minor' ? 6 : 1 };
              keyHidden = key.getAttribute('print-object') === 'no';
            }
            const time = node(item, 'time');
            if (time) {
              const groups = (value(time, 'beats') ?? '').split('+').map(Number);
              const numerator = groups.reduce((sum, count) => sum + count, 0);
              const denominator = Number(value(time, 'beat-type'));
              if (position || nodes(time, 'beats').length !== 1 || numerator < 1 || numerator > 16 ||
                groups.some(group => !Number.isInteger(group) || group < 1) || ![2, 4, 8, 16].includes(denominator))
                fail('暂不支持此拍号。');
              meter = meterChange = { numerator, denominator, groups: groups.length > 1 ? groups : defaultGroups(numerator, denominator) };
              meterHidden = time.getAttribute('print-object') === 'no';
            }
            break;
          }
          case 'backup':
          case 'forward': {
            position += (item.localName === 'backup' ? -1 : 1) * ticks(value(item, 'duration'), false);
            if (position < 0) fail('声部时间位置倒退到小节之前。');
            greatest = Math.max(greatest, position);
            last = undefined;
            break;
          }
          case 'note': {
            const grace = node(item, 'grace');
            if (grace) {
              const track = (value(item, 'staff') ?? '1') + '/' + (value(item, 'voice') ?? '1');
              const principal = lastPrincipal.get(track);
              const previous = grace.getAttribute('steal-time-previous');
              const after = /^cj-grace-after-/.test(item.getAttribute('id') ?? '') ||
                previous !== null && grace.getAttribute('steal-time-following') === null;
              const pitch = node(item, 'pitch');
              const step = steps.indexOf(value(pitch, 'step') ?? ' ');
              const octave = Number(value(pitch, 'octave'));
              const alter = Number(value(pitch, 'alter') ?? 0);
              if (!pitch || step < 0 || !Number.isInteger(octave) || !Number.isInteger(alter)) { warn('跳过了没有常规音高的倚音。'); break; }
              if (after && (!principal?.pitches.length || tickEnd(principal) !== tick(at + position))) {
                warn('后倚音没有找到同声部的主音。'); break;
              }
              const group = after ? ((principal!.grace ??= {}).after ??= { notes: [] }) : pendingGrace.get(track) ?? { notes: [] };
              if (!after) pendingGrace.set(track, group);
              const written = spell((octave + 1) * 12 + scale[step] + alter, step, fifths, mod(fifths * 7, 12));
              if (after && principal) {
                const principalTonic = measureTable(score).find(bar => principal.at < bar.end)?.tonic ?? mod(fifths * 7, 12);
                if (principalTonic !== mod(fifths * 7, 12)) Object.assign(written,
                  pitchAtSound((octave + 1) * 12 + scale[step] + alter, principalTonic));
              }
              if (node(item, 'accidental')?.getAttribute('cautionary') === 'yes') written.courtesy = true;
              let event: GraceNote | undefined = node(item, 'chord') ? group.notes.at(-1) : undefined;
              if (!event) {
                if (group.notes.length >= 64) { warn('超过 64 个音的倚音组已截断。'); break; }
                const base = values[value(item, 'type') ?? ''] ?? 48;
                event = { id: `xml-grace-${serial++}`, pitches: [], value: VALUES.includes(base as typeof VALUES[number]) ? base : 6,
                  dots: Math.min(2, nodes(item, 'dot').length) };
                group.notes.push(event);
                const amount = after ? previous : grace.getAttribute('steal-time-following');
                if (amount !== null && Number.isFinite(+amount)) group.borrow = Math.min(100, Math.max(0, (group.borrow ?? 0) + +amount));
              }
              if (event.pitches.length >= 8) break;
              const index = event.pitches.push(written) - 1;
              const explicitBeam = /^cj-grace-(?:before|after)-\d+-(\w+)$/.exec(item.getAttribute('id') ?? '')?.[1] as BeamMode | undefined;
              if (explicitBeam && BEAM_MODES.includes(explicitBeam)) event.beam = explicitBeam;
              const notation = node(item, 'notations');
              if (node(notation, 'fermata')) event.fermata = true;
              for (const mark of Array.from(node(notation, 'articulations')?.children ?? [])) {
                if (mark.localName === 'staccato' || mark.localName === 'accent' || mark.localName === 'tenuto') event[mark.localName] = true;
                if (mark.localName === 'breath-mark') {
                  const shape = mark.textContent?.trim();
                  event.breath = shape === 'comma' || shape === 'tick' || shape === 'salzedo' ? shape : 'upbow';
                }
              }
              const relations = graceLinks.get(group) ?? new Map();
              graceLinks.set(group, relations);
              const tieTypes = new Set([...nodes(item, 'tie'), ...nodes(notation, 'tied')].map(mark => mark.getAttribute('type')));
              const tieKey = 'tie:' + ((octave + 1) * 12 + scale[step] + alter);
              const relation = (kind: 'tie' | 'slur', key: string, type: string | null) => {
                if (type === 'stop') {
                  const prior = relations.get(key);
                  if (prior && prior.event !== event.id &&
                    (kind === 'slur' || group.notes[group.notes.length - 2]?.id === prior.event))
                    (group.links ??= []).push({ id: `xml-grace-link-${serial++}`, kind, from: prior.event, to: event.id, fromPitch: prior.pitch, toPitch: index });
                  relations.delete(key);
                } else if (type === 'start') relations.set(key, { event: event.id, pitch: index });
              };
              for (const type of ['stop', 'start']) if (tieTypes.has(type)) relation('tie', tieKey, type);
              for (const slur of nodes(notation, 'slur')) relation('slur', 'slur:' + (slur.getAttribute('number') ?? 1), slur.getAttribute('type'));
              break;
            }
            const rawDuration = ticks(value(item, 'duration'));
            const duration = occupied[partIndex].placeholder && inferred ? inferred : rawDuration;
            if (duration <= 0) fail('缺少有效的音符时值。');
            const track = (value(item, 'staff') ?? '1') + '/' + (value(item, 'voice') ?? '1');
            if (!mainTrack) mainTrack = track;
            if (!lanes.has(track)) lanes.set(track, []);
            const chord = !!node(item, 'chord');
            let event: ParsedNote;
            if (chord) {
              if (!last || lastTrack !== track) fail('无法确定叠音的归属。');
              event = last!;
              if (Math.abs(event.length - duration) > 1e-7 || !event.pitches.length || node(item, 'rest'))
                fail('暂不支持同一叠音组里不同音长。');
            } else {
              const written = values[value(item, 'type') ?? ''];
              const doubleTremolo = nodes(node(node(item, 'notations'), 'ornaments'), 'tremolo').some(mark =>
                mark.getAttribute('type') === 'start' || mark.getAttribute('type') === 'stop');
              const base = doubleTremolo && written && duration < dotted(written, nodes(item, 'dot').length) - 1e-7 ? written / 2 : written;
              const dots = nodes(item, 'dot').length;
              const eventAt = tick(at + position), finish = tick(at + position + duration);
              event = { id: `xml-note-${serial++}`, lane: track, at: eventAt, length: tick(finish - eventAt), pitches: [] };
              const modification = node(item, 'time-modification');
              const actual = Number(value(modification, 'actual-notes'));
              const normal = Number(value(modification, 'normal-notes')) * (doubleTremolo && base !== written ? 2 : 1);
              if (base && dots <= 2 && (Math.abs(dotted(base, dots) - duration) < 1e-7 || actual > 0 && normal > 0))
                Object.assign(event, { value: base, dots });
              const rawScale = base && dots <= 2 ? duration / dotted(base, dots) : actual && normal > 0 ? normal / actual : 1;
              const scale = actual > 0 && normal > 0 && Math.abs(normal / actual - rawScale) < 1e-6 ? normal / actual : rawScale;
              if (actual > 0 && normal > 0 && actual !== normal && base && VALUES.includes(base as typeof VALUES[number]))
                modified.set(event.id, { scale, count: Math.min(999, Math.max(2, actual)), unit: base });
              for (const mark of nodes(node(item, 'notations'), 'tuplet')) {
                const key = track + ':' + (mark.getAttribute('number') ?? '1');
                if (mark.getAttribute('type') === 'start') {
                  const groupActual = node(mark, 'tuplet-actual');
                  const groupNormal = node(mark, 'tuplet-normal');
                  const count = Number(value(groupActual, 'tuplet-number')) || actual || 3;
                  const candidate = values[value(groupActual, 'tuplet-type') ?? ''] ?? base ?? 48;
                  const unit = VALUES.includes(candidate as typeof VALUES[number]) ? candidate : 6;
                  const normalCount = Number(value(groupNormal, 'tuplet-number'));
                  const normalUnit = values[value(groupNormal, 'tuplet-type') ?? ''] ?? candidate;
                  const localScale = normalCount > 0 ? normalCount * dotted(normalUnit, nodes(groupNormal, 'tuplet-dot').length) /
                    (count * dotted(candidate, nodes(groupActual, 'tuplet-dot').length)) : undefined;
                  openTuplets.set(key, { start: eventAt, count: Math.min(999, Math.max(2, count)), unit, scale,
                    localScale,
                    hidden: mark.getAttribute('show-number') === 'none' && mark.getAttribute('bracket') === 'no' });
                } else if (mark.getAttribute('type') === 'stop') {
                  const head = openTuplets.get(key);
                  if (head && head.start < finish) {
                    const groups = trackTuplets.get(track) ?? [];
                    groups.push({ ...head, finish });
                    trackTuplets.set(track, groups);
                    openTuplets.delete(key);
                  } else warn('部分多连音没有匹配的组界。');
                }
              }
              lanes.get(track)!.push(event);
              position += duration;
              greatest = Math.max(greatest, position);
              last = event;
              lastTrack = track;
              lastPrincipal.set(track, event);
            }
            if (node(item, 'unpitched')) {
              if (chord) fail('无定音与定音叠放暂不支持。');
              event.unpitched = true;
              const previous = lanes.get(track)?.at(-2);
              if (previous?.unpitched && tickEnd(previous) === event.at &&
                nodes(item, 'tie').some(tie => tie.getAttribute('type') === 'stop')) event.unpitchedContinuation = true;
            } else if (!node(item, 'rest')) {
              const pitch = node(item, 'pitch');
              const step = steps.indexOf(value(pitch, 'step') ?? ' ');
              const octave = Number(value(pitch, 'octave'));
              const alter = Number(value(pitch, 'alter') ?? 0);
              if (!pitch || step < 0 || !Number.isInteger(octave) || !Number.isInteger(alter)) fail('不支持无定音或微分音。');
              const midi = (octave + 1) * 12 + scale[step] + alter;
              const written = spell(midi, step, fifths, mod(fifths * 7, 12));
              if (value(item, 'accidental') === 'natural' && !written.alter) written.natural = true;
              if (node(item, 'accidental')?.getAttribute('cautionary') === 'yes') written.courtesy = true;
              const pitchIndex = event.pitches.push(written) - 1;
              if (item.getAttribute('print-object') === 'no') (score.appearance ??= {})[appearanceKey({
                kind: 'pitch', id: event.id, at: event.at, index: pitchIndex
              })] = { visible: false };
              // Duplicate unisons each retain their own tie endpoint.
              const tieKey = track + ':' + midi + ':' + event.pitches.slice(0, pitchIndex).filter(other =>
                sound(other, mod(fifths * 7, 12)) === midi).length;
              const types = new Set(nodes(item, 'tie').map(tie => tie.getAttribute('type')));
              for (const tied of nodes(node(item, 'notations') ?? item, 'tied')) types.add(tied.getAttribute('type'));
              if (types.has('stop')) {
                const previous = ties.get(tieKey);
                if (previous && tickEnd(previous.note) === event.at)
                  score.spans.push({ kind: 'tie', from: previous.note.id, to: event.id, pitch: previous.pitch, targetPitch: pitchIndex });
                else warn('有同音线端点未匹配。');
                ties.delete(tieKey);
              }
              if (types.has('start')) ties.set(tieKey, { note: event, pitch: pitchIndex });
            }
            if ((node(item, 'rest') || event.unpitched) && item.getAttribute('print-object') === 'no') (score.appearance ??= {})[appearanceKey({
              kind: 'pitch', id: event.id, at: event.at, index: 0
            })] = { visible: false };
            if (!chord && event.pitches.length && pendingGrace.has(track)) {
              (event.grace ??= {}).before = pendingGrace.get(track);
              pendingGrace.delete(track);
            }
            if (!chord && preserveBeams) {
              let into = 0;
              let outgoing = 0;
              for (const beam of nodes(item, 'beam')) {
                const level = Number(beam.getAttribute('number') ?? 1);
                if (!Number.isInteger(level) || level < 1 || level > 8) continue;
                const type = beam.textContent?.trim();
                const flag = 1 << (level - 1);
                if (type === 'continue' || type === 'end') into |= flag;
                if (type === 'continue' || type === 'begin') outgoing |= flag;
              }
              event.xmlBeams = { [event.at]: into & (beamGroups.get(track) ?? 0) };
              beamGroups.set(track, outgoing);
            }
            for (const [index, lyric] of nodes(item, 'lyric').entries()) {
              const number = Number(lyric.getAttribute('number') ?? index + 1);
              if (!Number.isInteger(number) || number < 1 || number > 20) { warn('有无法识别编号的歌词。'); continue; }
              const raw = nodes(lyric, 'text').map(item => item.textContent ?? '').join('‿');
              const text = raw ? raw.slice(0, 300) : undefined;
              const syllabicNext = ['begin', 'middle'].includes(value(lyric, 'syllabic') ?? '') || undefined;
              const extension = node(lyric, 'extend');
              const type = extension?.getAttribute('type');
              const extend = type === 'stop' || type === 'continue' ? type : extension ? 'start' : undefined;
              if (!text && !extend) continue;
              if (lyric.getAttribute('print-object') === 'no') (score.appearance ??= {})[appearanceKey({
                kind: 'mark', id: event.id, field: 'lyric', verse: number
              })] = { visible: false };
              const previous = event.verses?.find(verse => verse.number === number);
              if (previous) {
                if (text && previous.text && text !== previous.text) warn('同一叠音组的同段歌词有冲突，保留首份。');
                previous.text ??= text;
                previous.extend ??= extend;
                previous.syllabicNext ??= syllabicNext;
              } else (event.verses ??= []).push({ number, text, extend, syllabicNext });
            }
            for (const mark of Array.from(node(item, 'notations')?.children ?? [])) {
              if (mark.localName === 'slur') {
                const key = track + ':' + (mark.getAttribute('number') ?? '1');
                if (mark.getAttribute('type') === 'start') slurs.set(key, event);
                if (mark.getAttribute('type') === 'stop') {
                  const previous = slurs.get(key);
                  if (previous && previous.at < event.at && previous.pitches.length && event.pitches.length)
                    score.spans.push({ kind: 'slur', from: previous.id, to: event.id });
                  else warn('有连音线端点未匹配。');
                  slurs.delete(key);
                }
              } else if (mark.localName === 'slide' || mark.localName === 'glissando') {
                const key = track + ':' + mark.localName + ':' + (mark.getAttribute('number') ?? '1');
                const pitch = event.pitches.length - 1;
                if (pitch < 0) continue;
                if (mark.getAttribute('type') === 'start') slides.set(key, { note: event, pitch });
                if (mark.getAttribute('type') === 'stop') {
                  const previous = slides.get(key);
                  if (previous && previous.note.at < event.at) score.spans.push({ kind: 'slide', from: previous.note.id, to: event.id,
                    pitch: previous.pitch, targetPitch: pitch });
                  else warn('有滑音端点未匹配。');
                  slides.delete(key);
                }
              } else if (mark.localName === 'ornaments') {
                let active: import('./score.js').Ornament | undefined;
                for (const child of Array.from(mark.children)) {
                  const name = child.localName;
                  const kind = ({ 'trill-mark': 'trill', 'inverted-mordent': 'upper-mordent', mordent: 'lower-mordent',
                    turn: 'turn', 'delayed-turn': 'turn', 'inverted-turn': 'inverted-turn', 'delayed-inverted-turn': 'inverted-turn' } as const)[name];
                  if (kind) {
                    active = (event.ornaments ??= {})[kind] = { delayed: name.startsWith('delayed-') || undefined,
                      fromUpper: child.getAttribute('start-note') === 'upper' || undefined };
                  } else if (name === 'wavy-line') {
                    if (event.ornaments?.trill) event.ornaments.trill.wave = true;
                  } else if (name === 'accidental-mark' && active) {
                    const alter = ({ 'flat-flat': -2, flat: -1, natural: 0, sharp: 1, 'double-sharp': 2, 'sharp-sharp': 2 } as Record<string, number>)[child.textContent?.trim() ?? ''];
                    if (alter !== undefined) active[child.getAttribute('placement') === 'below' ? 'lower' : 'upper'] = alter;
                  } else if (name === 'tremolo') {
                    const type = child.getAttribute('type') ?? 'single';
                    const strokes = Math.max(1, Math.min(3, Number(child.textContent) || 3));
                    if (type === 'start') tremolos.set(track, event);
                    else if (type === 'stop') {
                      const previous = tremolos.get(track);
                      if (previous && tickEnd(previous) === event.at && previous.length === event.length &&
                        previous.pitches.length === 1 && event.pitches.length === 1)
                        score.spans.push({ kind: 'tremolo', from: previous.id, to: event.id, strokes });
                      else warn('双音震音两端不可等值配对。');
                      tremolos.delete(track);
                    } else (event.ornaments ??= {}).tremolo = { strokes };
                  } else warn('暂未绘制装饰记号 ' + name + '。');
                }
              } else if (mark.localName === 'articulations') {
                for (const articulation of Array.from(mark.children)) {
                  if (['staccato', 'staccatissimo'].includes(articulation.localName)) event.staccato = true;
                  else if (articulation.localName === 'accent') event.accent = true;
                  else if (articulation.localName === 'tenuto') event.tenuto = true;
                  else if (articulation.localName === 'breath-mark') {
                    const shape = articulation.textContent?.trim();
                    event.breath = shape === 'comma' || shape === 'tick' || shape === 'salzedo' ? shape : 'upbow';
                  }
                  else warn('暂未绘制演奏记号 ' + articulation.localName + '。');
                }
              } else if (mark.localName === 'fermata') event.fermata = true;
              else if (mark.localName !== 'tied' && mark.localName !== 'tuplet') warn('暂未绘制记号 ' + mark.localName + '。');
            }
            break;
          }
          case 'direction': {
            const track = value(item, 'voice') || value(item, 'staff')
              ? (value(item, 'staff') ?? '1') + '/' + (value(item, 'voice') ?? '1') : '';
            const location = tick(at + position + ticks(value(item, 'offset'), false));
            const sound = node(item, 'sound');
            const soundAt = value(sound, 'offset') === undefined ? location : at + position + ticks(value(sound, 'offset'), false);
            const tempo = Number(sound?.getAttribute('tempo') ?? 0);
            const marks = nodes(item, 'direction-type').flatMap(group => Array.from(group.children));
            const tagged = /^(?:shupu|choral-jianpu)-extension-([a-zA-Z]+)-(left|right)-[1-9]\d*$/.exec(item.getAttribute('id') ?? '');
            if (tagged && isExtensionText(tagged[1]) && !sound && marks.length === 1 &&
              marks[0].localName === (tagged[1] === 'rehearsal' ? 'rehearsal' : 'words')) {
              const caption = marks[0].textContent?.trim().slice(0, 300);
              if (caption) taggedDirections.push({ at: location, track, field: tagged[1], right: tagged[2] === 'right', caption, where });
              break;
            }
            const words = marks.find(mark => mark.localName === 'words');
            const dynamicId = item.getAttribute('id') ?? '';
            const textDynamic = /^cj-dyn-(crescendo|diminuendo)-(auto|p{1,3}|mf|mp|f{1,3})-\d+$/.exec(dynamicId);
            const textStop = /^cj-dyn-stop-\d+$/.test(dynamicId);
            const dashMark = marks.find(mark => mark.localName === 'dashes');
            const dynamicCaption = words?.textContent?.trim().slice(0, 300) ?? '';
            const recognized = /^cresc(?:\.|endo|\s|$)/i.test(dynamicCaption) ? 'crescendo' :
              /^(?:dim(?:\.|inuendo|\s|$)|decresc(?:\.|endo|\s|$))/i.test(dynamicCaption) ? 'diminuendo' : undefined;
            const dashKey = track + ':dynamic-text:' + (dashMark?.getAttribute('number') ?? '1');
            const dashType = dashMark?.getAttribute('type');
            if (dashMark && (textDynamic || textStop || dashType === 'start' && recognized ||
              (dashType === 'stop' || dashType === 'continue') && wedges.has(dashKey))) {
              if (dashType === 'start') wedges.set(dashKey, { at: location, kind: (textDynamic?.[1] as GradualDynamic['kind'] | undefined) ?? recognized!,
                track, where, dynamicText: dynamicCaption,
                dynamicTarget: !textDynamic || textDynamic[2] === 'auto' ? undefined : textDynamic[2] as DynamicStep });
              else if (dashType === 'stop') {
                const start = wedges.get(dashKey);
                if (start) wedgeEnds.push({ ...start, start: start.at, end: location });
                else warn('有文字渐变线端点未匹配。');
                wedges.delete(dashKey);
              }
              break;
            }
            if (/^cj-harmony-\d+-\d+$/.test(item.getAttribute('id') ?? '') && words?.textContent?.trim() && !sound) {
              chordDirections.push({ id: `xml-chord-${++serial}`, at: location, track, text: words.textContent.trim().slice(0, 300),
                hidden: words.getAttribute('print-object') === 'no', where });
              break;
            }
            const caption = words?.textContent?.trim().slice(0, 80) ?? '';
            const isRoute = readRoute(index, item, sound, marks, caption);
            const metronome = marks.find(mark => mark.localName === 'metronome');
            const rateText = value(metronome, 'per-minute');
            const unit = values[value(metronome, 'beat-unit') ?? ''];
            const units = nodes(metronome, 'beat-unit');
            const dotsOf = (beat: Element | undefined) => {
              let dots = 0;
              for (let item = beat?.nextElementSibling; item?.localName === 'beat-unit-dot'; item = item.nextElementSibling) dots++;
              return dots;
            };
            const dots = dotsOf(units[0]), rightDots = dotsOf(units[1]);
            const rightUnit = values[units[1]?.textContent?.trim() ?? ''];
            const bass = tempoWord(caption);
            const gradual = tempoLineWord(caption);
            const dash = marks.find(mark => mark.localName === 'dashes');
            const dashKind = dash?.getAttribute('type');
            const dashId = track + ':' + (dash?.getAttribute('number') ?? '1');
            const rank = -partIndex * .01;
            const base = { id: `xml-tempo-${partIndex}-${location}`, at: location };
            let usedWords = isRoute || readSwing(sound, soundAt, caption) || isTempoLineWord(location, caption);
            let usedDash = false;
            if (dashKind === 'start' && gradual) {
              tempoDashes.set(dashId, { from: location, kind: gradual, label: caption });
              usedWords = usedDash = true;
            } else if (dashKind === 'continue' && tempoDashes.has(dashId)) usedDash = true;
            else if (dashKind === 'stop' && tempoDashes.has(dashId)) {
              const line = tempoDashes.get(dashId)!;
              tempoDashes.delete(dashId);
              if (line.from < location && !tempoLines.has(line.from)) tempoLines.set(line.from,
                { id: `xml-tempo-line-${partIndex}-${line.from}`, ...line, to: location, target: validTempo(tempo) ? tempo : undefined });
              usedDash = true;
            }
            const numerical = Number(rateText?.match(/\d+(?:\.\d+)?/)?.[0]);
            if (metronome && !rateText && TEMPO_UNITS.some(value => value === unit) && TEMPO_UNITS.some(value => value === rightUnit) &&
              dots <= 2 && rightDots <= 2) {
              writeTempo({ ...base, kind: 'modulation', unit, dots, rightUnit, rightDots,
                override: validTempo(tempo) ? tempo : undefined }, 3 + rank);
            } else if (metronome && rateText && TEMPO_UNITS.includes(unit as typeof TEMPO_UNITS[number]) && dots <= 2 &&
              (validTempo(numerical) || validTempo(tempo))) {
              const bpm = validTempo(numerical) ? numerical : tempo * QUARTER / dotted(unit, dots);
              if (validTempo(bpm)) writeTempo({ ...base, kind: 'metronome', unit, dots, bpm,
                label: !usedWords && caption ? caption : undefined,
                writtenRate: String(bpm) === rateText ? undefined : rateText.slice(0, 100),
                override: validTempo(tempo) && soundAt === location && tempo !== bpm * dotted(unit, dots) / QUARTER ? tempo : undefined,
                appearance: metronome.getAttribute('print-object') === 'no' ? { visible: false, layout: false } : undefined }, 3 + rank);
              usedWords = !!caption;
            } else if (!usedWords && /^a\s+tempo\.?$/i.test(caption)) {
              writeTempo({ ...base, kind: 'restore', label: caption, override: validTempo(tempo) ? tempo : undefined }, 2 + rank);
              usedWords = true;
            } else if (!usedWords && /^tempo\s+primo\.?$/i.test(caption)) {
              writeTempo({ ...base, kind: 'primo', label: caption, override: validTempo(tempo) ? tempo : undefined }, 2 + rank);
              usedWords = true;
            } else if (!usedWords && caption && (bass !== undefined || validTempo(tempo) && soundAt === location)) {
              writeTempo({ ...base, kind: 'word', label: caption, bpm: bass ?? tempo, override: validTempo(tempo) && tempo !== bass ? tempo : undefined }, 2 + rank);
              usedWords = true;
            }
            if (validTempo(tempo) && (!metronome && !usedWords && !usedDash || soundAt !== location))
              writeTempo({ ...base, id: `xml-tempo-${partIndex}-${soundAt}`, at: soundAt, kind: 'metronome', unit: QUARTER, dots: 0, bpm: tempo,
                appearance: { visible: false, layout: false } }, rank);
            for (const item of marks) {
              const key = track + ':' + (item.getAttribute('number') ?? '1');
              const kind = item.getAttribute('type');
              if (item.localName === 'dynamics') {
                const dynamic = Array.from(item.children).map(mark => mark.localName === 'other-dynamics' ? mark.textContent?.trim() : mark.localName).filter(Boolean).join(' ');
                if (dynamic) directions.push({ at: location, track, dynamic, where });
              }
              else if (item.localName === 'words') { if (!usedWords || item !== words) directions.push({ at: location, track, text: item.textContent?.trim(), where }); }
              else if (item.localName === 'rehearsal' && !partIndex) directions.push({ at: location, track, rehearsal: item.textContent?.trim(), where });
              else if (item.localName === 'rehearsal' || item.localName === 'segno' || item.localName === 'coda') continue;
              else if (item.localName === 'wedge') {
                if (kind === 'crescendo' || kind === 'diminuendo') wedges.set(key, { at: location, kind, track, where,
                  dynamicTarget: /^cj-wedge-(p{1,3}|mf|mp|f{1,3})-\d+$/.exec(dynamicId)?.[1] as DynamicStep | undefined });
                else if (kind === 'stop') {
                  const start = wedges.get(key);
                  if (start) wedgeEnds.push({ ...start, start: start.at, end: location });
                  else warn('有渐强或渐弱线端点未匹配。');
                  wedges.delete(key);
                }
              } else if (item.localName === 'metronome') {
                if (rateText && !tempos.has(location)) directions.push({ at: location, track, text: `${value(item, 'beat-unit') ?? '♩'} = ${rateText}`, where });
              } else if (item.localName !== 'dashes' || !usedDash) warn('暂未绘制说明记号 ' + item.localName + '。');
            }
            break;
          }
          case 'sound': {
            readRoute(index, item, item);
            const tempo = Number(item.getAttribute('tempo') ?? 0);
            const location = at + position + ticks(value(item, 'offset'), false);
            readSwing(item, location);
            if (validTempo(tempo)) writeTempo({ id: `xml-tempo-${partIndex}-${location}`, at: location, kind: 'metronome', unit: QUARTER,
              dots: 0, bpm: tempo, appearance: { visible: false, layout: false } }, -partIndex * .01);
            break;
          }
          case 'barline': {
            if (partIndex) break;
            const repeat = node(item, 'repeat');
            if (repeat?.getAttribute('after-jump') === 'yes') repeatsAfterJump = true;
            const direction = repeat?.getAttribute('direction');
            const style = value(item, 'bar-style');
            const location = item.getAttribute('location') ?? 'right';
            const ending = node(item, 'ending');
            if (location === 'middle' && (repeat || style && style !== 'none' || !ending)) {
              warn('小节内的小节线样式未导入。');
              if (!ending) break;
            }
            const boundaryIndex = direction === 'forward' || location === 'left' ? index : index + 1;
            const fermata = node(item, 'fermata');
            if (location !== 'middle' && fermata) {
              const target = (score.boundaries ??= {})[boundaryIndex] ??= {};
              target.fermata = true;
            }
            if (location !== 'middle' && (repeat || style)) {
              const target = (score.boundaries ??= {})[boundaryIndex] ??= {};
              if (direction === 'forward') target.style = target.style === 'repeat-end' || target.style === 'repeat-both' ? 'repeat-both' : 'repeat-start';
              else if (direction !== 'backward' && !target.style && style) {
                target.style = style === 'light-heavy' ? 'final' : style === 'light-light' ? 'double' : 'normal';
                if (style === 'none') target.appearance = { visible: false };
                else if (!['regular', 'light-heavy', 'light-light'].includes(style)) warn('特殊小节线已转换为普通线。');
              }
            }
            if (location !== 'middle' && repeat?.getAttribute('direction') === 'backward') {
              const times = Number(repeat!.getAttribute('times') ?? 2);
              const target = score.boundaries![boundaryIndex];
              target.style = target.style === 'repeat-start' || target.style === 'repeat-both' ? 'repeat-both' : 'repeat-end';
              if (Number.isInteger(times) && times >= 1 && times <= 8) target.repeats = times - 1;
              else { target.repeats = 1; warn('不支持此反复次数，按额外反复一遍导入。'); }
            }
            const type = ending?.getAttribute('type');
            if (type === 'start') {
              const passes = (ending.getAttribute('number') ?? '').split(',').map(Number);
              if (passes.length && passes.every(pass => Number.isInteger(pass) && pass >= 1 && pass <= 8))
                openEnding = { start: location === 'right' ? index + 1 : index, passes,
                  fromAt: location === 'middle' && position > 0 ? at + position : undefined,
                  appearance: ending.getAttribute('print-object') === 'no' ? { visible: false } : undefined };
              else warn('无法识别一二房子的编号。');
            } else if (type === 'stop' || type === 'discontinue') {
              const end = location === 'left' || location === 'middle' && position === 0 ? index - 1 : index;
              const toAt = location === 'middle' && position > 0 ? at + position : undefined;
              if (openEnding && end >= openEnding.start && (toAt === undefined || openEnding.fromAt === undefined || toAt > openEnding.fromAt))
                (score.endings ??= []).push({ ...openEnding, end, toAt, open: type === 'discontinue' });
              else warn('有一二房子未匹配有效起点。');
              openEnding = undefined;
            }
            break;
          }
          case 'print':
            if (!partIndex && index > 0) {
              const hardBreak = item.getAttribute('new-page') === 'yes' ? 'page' : item.getAttribute('new-system') === 'yes' ? 'line' : undefined;
              if (hardBreak) ((score.boundaries ??= {})[index] ??= {}).break = hardBreak;
            }
            break;
          case 'harmony': {
            const root = node(item, 'root');
            const numeral = node(item, 'numeral');
            const kind = node(item, 'kind');
            const bass = node(item, 'bass');
            const degree = node(item, 'degree');
            const natural = (alter: number) => Number.isInteger(alter) && Math.abs(alter) <= 2 ?
              (alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter)) : '?';
            const rootStep = value(root, 'root-step');
            const bassStep = value(bass, 'bass-step');
            const number = value(numeral, 'numeral-root');
            const major = value(node(numeral, 'numeral-key'), 'numeral-mode') !== 'minor';
            const explicitFifths = Number(value(node(numeral, 'numeral-key'), 'numeral-fifths') ?? fifths);
            const name = rootStep ? rootStep + natural(Number(value(root, 'root-alter') ?? 0)) :
              number ? natural(Number(value(numeral, 'numeral-alter') ?? 0)) + number : '';
            const standardKind = kind?.textContent?.trim();
            const writtenQuality = kind?.getAttribute('text')?.trim() || '';
            const knownQuality = Object.keys(chordKinds).find(key => chordKinds[key] === standardKind);
            const quality = (writtenQuality && parseChord('C' + writtenQuality) ? writtenQuality : '') || (value(degree, 'degree-value') === '9' &&
              value(degree, 'degree-type') === 'add' && kind?.textContent === 'major' ? 'add9' :
              knownQuality ?? '');
            const bassName = bassStep ? bassStep + natural(Number(value(bass, 'bass-alter') ?? 0)) : '';
            const modeChange = numeral && (!major || explicitFifths !== fifths) && /^[#b]{0,2}[1-7]$/.test(name);
            const converted = modeChange ? degreeForNote(noteForDegree(name, explicitFifths, !major), fifths, false) : name;
            const slash = numeral && /^[A-G][#b]{0,2}$/.test(bassName) ? degreeForNote(bassName, fifths, false) : bassName;
            const chord = standardKind === 'none' ? parseChord('N.C.') : knownQuality !== undefined || quality ?
              parseChord(converted + quality + (slash ? '/' + slash : '')) : undefined;
            if (!chord) { warn('有不支持的和弦代号写法。'); break; }
            if (nodes(item, 'kind').length > 1 || value(degree, 'degree-value') && quality !== 'add9')
              warn('和弦的附加级数或复合写法已简化。');
            const labelId = item.getAttribute('id') ?? '';
            const voice = /^cj-harmony-(\d+)-\d+$/.exec(labelId)?.[1];
            const saved = voice && Object.hasOwn(chordLabels, labelId) ? chordLabels[labelId] : undefined;
            const text = typeof saved?.text === 'string' && saved.text.trim() ? saved.text.slice(0, 300) : chord.text;
            const actual = typeof saved?.actual === 'string' && saved.actual.length <= 300 && parseChord(saved.actual) ? saved.actual : undefined;
            const staff = value(item, 'staff');
            chordDirections.push({ id: `xml-chord-${++serial}`, at: tick(at + position + ticks(value(item, 'offset'), false)),
              text, actual, track: voice || staff ? (staff ?? '1') + '/' + (voice ?? '1') : '',
              hidden: item.getAttribute('print-object') === 'no', where });
            break;
          }
          case 'figured-bass':
            warn('暂未导入数字低音。');
        }
      }
      const nominal = meter.numerator * QUARTER * 4 / meter.denominator;
      const length = partIndex ? score.measures[index].length : inferred ?? Math.max(nominal, ...occupied.map(item => item.end));
      if (!partIndex && endpoints.length > 1 && endpoints.some(end => end !== nominal)) warn('各声部小节终点不一致，已按共同边界保留完整时值。');
      if (tick(greatest) > length) fail('音符超出小节时值，无法安全导入。');
      if (!partIndex) {
        const entry: Measure = { length, number, actualMeter: length !== nominal ? actualMeterFromLength(length, meter) : undefined,
          meterHidden: meterHidden || undefined, keyHidden: keyHidden || undefined };
        const saved = barSettings[index];
        if (saved && typeof saved === 'object') {
          const actual = saved.meter;
          if (actual && Number.isInteger(actual.numerator) && actual.numerator > 0 && actual.numerator <= 16 &&
            [2, 4, 8, 16].includes(actual.denominator) && Array.isArray(actual.groups) &&
            actual.groups.every(group => Number.isInteger(group) && group > 0) && actual.groups.reduce((a, b) => a + b, 0) === actual.numerator &&
            meterLength(actual) === length) entry.actualMeter = actual;
          if (typeof saved.pickup === 'boolean') entry.pickup = saved.pickup;
        }
        if (index === 0) {
          Object.assign(score, meter); score.tonic = tonicChange ?? 0; score.key = keyChange;
          if (saved?.firstKey === true) entry.key = keyChange;
          if (saved?.firstMeter === true) entry.meter = meterChange;
          if (saved?.titleSignatures?.key === true || saved?.titleSignatures?.meter === true)
            score.titleSignatures = { key: saved.titleSignatures.key === true, meter: saved.titleSignatures.meter === true };
        }
        else {
          if (meterChange) entry.meter = meterChange;
          if (keyChange !== undefined) entry.key = keyChange;
        }
        score.measures.push(entry);
      } else {
        const entry = score.measures[index];
        const meterExpected = index ? entry.meter : score;
        if (entry.number !== number || meterChange && (!meterExpected ||
          meterChange.numerator !== meterExpected.numerator || meterChange.denominator !== meterExpected.denominator))
          fail('小节编号或拍号与其他声部不一致。');
      }
      at = tick(at + length);
    }
    const table = measureTable(score);
    const dangling = [
      ...[...ties.values()].map(({ note }) => ({ at: note.at, note, text: '有未闭合的同音线。' })),
      ...[...slurs.values()].map(note => ({ at: note.at, note, text: '有未闭合的连音线。' })),
      ...[...slides.values()].map(({ note }) => ({ at: note.at, note, text: '有未闭合的滑音。' })),
      ...[...wedges.values()].map(({ at, track }) => ({ at, track, text: '有未闭合的力度线。' }))
    ];
    for (const entry of dangling) {
      const bar = table.find(bar => entry.at < bar.end);
      if (!bar) continue;
      const track = 'track' in entry ? entry.track : [...lanes.entries()].find(([, notes]) => notes.includes(entry.note))?.[0] ?? '';
      unresolved.push({ text: `${name} · 第 ${bar.number} 小节：${entry.text}`, measure: bar.index, offset: entry.at - bar.start, track });
    }
    if (openTuplets.size) warnings.add(name + '：有未闭合的多连音，按实际时值恢复。');
    if (pendingGrace.size) warnings.add(name + '：有前倚音未找到所属主音。');
    if (!partIndex && openEnding) warnings.add(name + '：有一二房子未闭合。');
    const eventsFor = (track: string) => lanes.get(track || mainTrack) ?? [];
    const locate = (events: ParsedNote[], at: number) => events.find(note => note.at === at)
      ?? events.find(note => note.at < at && at < note.at + note.length) ?? events.find(note => note.at > at);
    for (const direction of directions) {
      const note = locate(eventsFor(direction.track), direction.at);
      if (!note) { warnings.add(direction.where + '：有文字或力度没有找到对应音符。'); continue; }
      if (note.at !== direction.at) warnings.add(direction.where + '：文字或力度已贴到邻近音符。');
      if (direction.dynamic) note.dynamic = [note.dynamic, direction.dynamic].filter(Boolean).join(' ').slice(0, 300);
      if (direction.text) note.text = [note.text, direction.text].filter(Boolean).join(' ').slice(0, 300);
      if (direction.rehearsal) note.rehearsal = direction.rehearsal.slice(0, 300);
    }
    for (const wedge of wedgeEnds) {
      const events = eventsFor(wedge.track);
      const first = locate(events, wedge.start);
      const last = locate(events, wedge.end) ?? events.at(-1);
      const minimum = wedge.track && wedge.track !== mainTrack ? events[0]?.at ?? 0 : 0;
      const maximum = wedge.track && wedge.track !== mainTrack ? (events.at(-1)?.at ?? 0) + (events.at(-1)?.length ?? 0) : at;
      if (first && last && wedge.start >= minimum && wedge.end <= maximum && wedge.start < wedge.end) {
        score.spans.push({ kind: wedge.kind, from: first.id, to: last.id, fromAt: wedge.start, toAt: wedge.end,
          dynamicText: wedge.dynamicText, dynamicTarget: wedge.dynamicTarget });
      } else warnings.add(wedge.where + '：力度线没有有效的声部范围。');
    }
    for (const [track, events] of lanes) {
      events.sort((left, right) => left.at - right.at);
      if (events.some((event, index) => index > 0 && tickEnd(events[index - 1]) > event.at))
        throw Error(name + '：同一声部出现重叠音符，未能安全导入。');
      const target = track === mainTrack ? main : {
        id: head + ':' + track, name: name.slice(0, 30) + ' · ' + track,
        parent: head, octave: main.octave, start: events[0].at, end: tickEnd(events.at(-1)!)
      };
      if (target !== main) score.lanes.push(target);
      const octaves = events.flatMap(event => event.pitches.map(pitch => pitch.octave)).sort((left, right) => left - right);
      target.octave = Math.max(1, Math.min(7, octaves[Math.floor(octaves.length / 2)] ?? main.octave));
      for (const event of events) score.notes.push({ ...event, lane: target.id });
      const groups = trackTuplets.get(track) ?? [];
      const explicit = [...groups];
      for (let i = 0; i < events.length; i++) {
        const note = events[i], mod = modified.get(note.id);
        if (!mod || explicit.some(group => group.start <= note.at && note.at < group.finish)) continue;
        let finish = tickEnd(note);
        const desired = tick(note.at + mod.count * mod.unit * mod.scale);
        while (i + 1 < events.length && finish < desired - 1e-7 && events[i + 1].at === finish &&
          Math.abs((modified.get(events[i + 1].id)?.scale ?? 0) - mod.scale) < 1e-7 &&
          !explicit.some(group => group.start <= finish && finish < group.finish)) finish = tickEnd(events[++i]);
        groups.push({ start: note.at, finish, ...mod });
      }
      const bars = measureTable(score);
      for (const bar of bars) {
        const active = groups.filter(group => group.start < bar.end && group.finish > bar.start)
          .sort((a, b) => a.start - b.start || b.finish - a.finish);
        const stack: { source: ParsedGroup; id: string; scale: number }[] = [];
        for (const source of active) {
          const at = Math.max(source.start, bar.start), finish = Math.min(source.finish, bar.end);
          while (stack.length && stack.at(-1)!.source.finish <= at) stack.pop();
          if (stack.length && source.finish > stack.at(-1)!.source.finish) {
            warnings.add(name + '：有交叠而非嵌套的多连音，已保留其原时值。'); continue;
          }
          const id = `xml-tuplet-${serial++}`;
          const length = tick(finish - at);
          const scale = source.localScale === undefined ? source.scale : source.localScale * (stack.at(-1)?.scale ?? 1);
          (score.tuplets ??= []).push({ id, lane: target.id, at, length, count: source.count, unit: source.unit,
            written: length / scale, parent: stack.at(-1)?.id });
          stack.push({ source, id, scale });
          if (source.hidden) (score.appearance ??= {})[appearanceKey({ kind: 'tuplet', id })] = { visible: false };
          if (at !== source.start || finish !== source.finish) {
            const prefix = `${name} 第 ${bar.number} 小节`;
            warnings.add(prefix + '：跨小节多连音已按小节分段，保留实际时值。');
          }
        }
      }
      for (const direction of taggedDirections) if ((direction.track || mainTrack) === track)
        extensionDirections.push({ ...direction, lane: target.id });
      for (const entry of unresolved) if ((entry.track && lanes.has(entry.track) ? entry.track : mainTrack) === track) {
        const { text, measure, offset } = entry;
        locatedNotices.push({ text: text.slice(0, 300), measure, offset, lane: target.id });
      }
      for (const symbol of chordDirections) if ((symbol.track && lanes.has(symbol.track) ? symbol.track : mainTrack) === track) {
        if (symbol.at < 0 || symbol.at >= at || target.parent && (symbol.at < target.start! || symbol.at >= target.end!)) {
          warnings.add(symbol.where + '：和弦代号的拍位无效。');
          continue;
        }
        const { id, at: beat, text, actual } = symbol;
        if ((score.chordSymbols?.length ?? 0) >= 5000) { warnings.add(symbol.where + '：超过和弦代号容量，已省略。'); continue; }
        (score.chordSymbols ??= []).push({ id, at: beat, text, actual, lane: target.id });
        if (symbol.hidden) (score.appearance ??= {})[appearanceKey({ kind: 'chord-symbol', id })] = { visible: false };
      }
    }
  }
  for (const [index, marks] of routes) {
    for (const mark of marks) if (mark.kind === 'dc' || mark.kind === 'ds') {
      if (mark.repeat === undefined) mark.repeat = repeatsAfterJump || undefined;
      if (inferredRoutes.has(mark.id)) {
        const earlier = [...routes].filter(([bar]) => bar < index).flatMap(([, values]) => values);
        if (earlier.some(item => item.kind === 'tocoda')) mark.until = 'coda';
        else if (earlier.some(item => item.kind === 'fine')) mark.until = 'fine';
      }
    }
    score.measures[index].route = marks;
  }
  const table = measureTable(score);
  if (extensionDirections.length) {
    const { byLane } = notation(score);
    for (const { lane, at, field, right, caption, where } of extensionDirections) {
      const tokens = byLane.get(lane) ?? [];
      const token = tokens.find(token => token.tail.includes(at));
      const note = token?.note ?? score.notes.find(note => note.lane === lane && note.at <= at && at < note.at + note.length);
      if (!note) { warnings.add(where + '：未找到增时线文字的所属音符。'); continue; }
      const extension = token ? at - note.at : undefined;
      const target = extension === undefined ? note : ((note.extensionText ??= {})[extension] ??= {});
      target[field] = [target[field], caption].filter(Boolean).join(' ').slice(0, 300);
      if (extension === undefined) warnings.add(where + '：原拍位没有增时线，文字已挂到所属音符。');
      if (right && field === 'interNoteText')
        (score.appearance ??= {})[appearanceKey({ kind: 'mark', id: note.id, field, extension })] = { noteSide: 'right' };
    }
  }
  const limit = table.at(-1)!.end;
  const importedTempo = [...[...tempos.values()].map(item => item.mark), ...swingMarks.values()].filter(mark => mark.at < limit);
  const initial = tempos.get(0)?.mark;
  if (initial) {
    const bpm = initial.override ?? (initial.kind === 'metronome' ? initial.bpm * dotted(initial.unit, initial.dots) / QUARTER :
      initial.kind === 'word' ? initial.bpm : score.tempo);
    score.tempo = Math.round(Math.min(300, Math.max(20, bpm)));
  }
  if (importedTempo.length) score.tempoMarks = importedTempo;
  if (tempoLines.size) {
    score.tempoLines = [];
    for (const line of [...tempoLines.values()].filter(line => line.from >= 0 && line.to <= limit).sort((a, b) => a.from - b.from)) {
      const marks = (score.tempoMarks ?? []).filter(mark => mark.kind !== 'swing' && mark.kind !== 'straight' && mark.at > line.from && mark.at < line.to);
      const sampled = marks.filter((mark): mark is Extract<TempoMark, { kind: 'metronome' }> =>
        mark.kind === 'metronome' && (tempos.get(mark.at)?.rank ?? 3) <= 0);
      if (sampled.length >= (line.target === undefined ? 2 : 1) && marks.length === sampled.length) {
        const start = scoreTempoAt(score, line.from);
        const sample = sampled.at(-1)!;
        const target = line.target ?? start + (sample.bpm - start) * (line.to - line.from) / (sample.at - line.from);
        if (validTempo(target) && sampled.every(mark => Math.abs(mark.bpm - start -
          (target - start) * (mark.at - line.from) / (line.to - line.from)) < .02)) {
          line.target = target;
          const samples = new Set(sampled.map(mark => mark.id));
          score.tempoMarks = score.tempoMarks?.filter(mark => !samples.has(mark.id));
        }
      }
      score.tempoLines.push(line);
    }
  }
  if (score.measures[0].pickup === undefined) {
    const [first, second] = table;
    score.measures[0].pickup = first.length < meterLength(first.meter) && (!second ||
      second.length === meterLength(second.meter) && second.meter.numerator === first.meter.numerator && second.meter.denominator === first.meter.denominator);
  }
  score.importNotices = [...locatedNotices, ...[...warnings].map(text => {
    const prefix = text.slice(0, text.lastIndexOf('：'));
    return { text: text.slice(0, 300), ...locations.get(prefix) };
  })].slice(0, 5000);
  if (tempoMetadata && tempoMetadata.length < 2_000_000) try {
    const { base, marks, lines } = JSON.parse(tempoMetadata);
    return { score: openScore(JSON.stringify({ ...score, tempo: base, tempoMarks: marks, tempoLines: lines?.map((line: TempoLine) => ({ ...line,
      lane: score.lanes.some(lane => lane.id === line.lane) ? line.lane : undefined })) })), warnings: score.importNotices };
  } catch { /* Standard MusicXML directions remain available. */ }
  return { score: openScore(JSON.stringify(score)), warnings: score.importNotices };
}
