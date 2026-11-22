import { degreeForNote, noteForDegree, parseChord, transposeChord } from './chord-symbol.js';
import type { ChordSymbol } from './chord-symbol.js';
import type { LineRule, SectionLineRule } from './line-layout.js';
import { ROUTE_KINDS, routeAtStart } from './roadmap.js';
import type { RouteMark } from './roadmap.js';
import type { LinkedPart } from './linked-parts.js';

export const QUARTER = 96;
export const VALUES = [384, 192, 96, 48, 24, 12, 6] as const;
export const tick = (value: number) => Math.round(value * 1e8) / 1e8;
export const tickEnd = (event: { at: number; length: number }) => tick(event.at + event.length);
export function rhythmFraction(value: number, tolerance = 2e-8): [number, number] {
  const sign = value < 0 ? -1 : 1;
  let remaining = Math.abs(value), numerator = 1, denominator = 0, priorN = 0, priorD = 1;
  for (let i = 0; i < 32; i++) {
    const whole = Math.floor(remaining);
    const nextN = whole * numerator + priorN, nextD = whole * denominator + priorD;
    if (!Number.isSafeInteger(nextN) || nextD > 10000000) break;
    [priorN, numerator] = [numerator, nextN];
    [priorD, denominator] = [denominator, nextD];
    if (Math.abs(sign * numerator / denominator - value) <= tolerance) return [sign * numerator, denominator];
    if (remaining === whole) break;
    remaining = 1 / (remaining - whole);
  }
  throw Error('节拍分数超出可交换的精度。');
}
export type RhythmAlignment = 'full' | 'half' | 'none';
export interface Tuplet { id: string; lane: string; at: number; length: number; count: number; unit: number; parent?: string; written?: number; ratio?: [number, number] }
export const TONICS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJOR_KEYS = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR_KEYS = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
const DEFAULT_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
export interface KeySignature { fifths: number; degree: 1 | 6 }
export const keyTonic = (key: KeySignature) => (key.fifths * 7 % 12 + 12) % 12;
export const keyName = (key: KeySignature) => `${key.degree}=${(key.degree === 1 ? MAJOR_KEYS : MINOR_KEYS)[key.fifths + 7]}`;
const keyForTonic = (tonic: number): KeySignature => ({ fifths: DEFAULT_FIFTHS[tonic], degree: 1 });
export const sameKey = (a: KeySignature, b: KeySignature) => a.fifths === b.fifths && a.degree === b.degree;
export function setKeySignature(score: Score, index: number, key: KeySignature, only = false, transpose = false) {
  const old = measureTable(score);
  const after = old[index + 1]?.key;
  if (only && after && !score.measures[index + 1].key && score.measures[index + 1].tonic === undefined)
    score.measures[index + 1].key = after;
  score.measures[index].key = key;
  delete score.measures[index].tonic;
  delete score.measures[index].keyHidden;
  const updated = measureTable(score);
  for (const symbol of score.chordSymbols ?? []) {
    const bar = old.find(item => symbol.at < item.end);
    if (!bar) continue;
    const next = updated[bar.index];
    if (bar.key.fifths === next.key.fifths) continue;
    const field = symbol.actual === undefined ? 'text' : 'actual';
    const written = symbol[field]!;
    if (transpose) symbol[field] = transposeChord(written, bar.key.fifths, false, next.key.fifths, false);
    else {
      const chord = parseChord(written);
      if (chord?.mode !== 'degree') continue;
      const convert = (degree: string) => degreeForNote(noteForDegree(degree, bar.key.fifths, false), next.key.fifths, false);
      const relative = convert(chord.root) + chord.quality + (chord.bass ? '/' + convert(chord.bass) : '');
      symbol[field] = parseChord(relative)?.text ?? noteForDegree(chord.root, bar.key.fifths, false) + chord.quality +
        (chord.bass ? '/' + noteForDegree(chord.bass, bar.key.fifths, false) : '');
    }
  }
  if (transpose) { pruneTies(score); return; }
  for (const note of score.notes) {
    const measure = old.find(item => note.at < item.end)!;
    const tonic = updated[measure.index].tonic;
    if (tonic !== measure.tonic) respellNote(note, measure.tonic, tonic);
  }
}

export interface Pitch { degree: number; octave: number; alter: number; natural?: boolean; courtesy?: boolean; signStyle?: 'show' | 'hide' }
export const GRACE_SIDES = ['before', 'after'] as const;
export type GraceSide = typeof GRACE_SIDES[number];
export interface GraceNote { id: string; pitches: Pitch[]; value: number; dots?: number; beam?: BeamMode;
  staccato?: boolean; accent?: boolean; tenuto?: boolean; fermata?: boolean; breath?: BreathShape }
export interface GraceLink { id: string; kind: 'tie' | 'slur'; from: string; to: string; fromPitch: number; toPitch: number }
export interface GraceGroup { notes: GraceNote[]; borrow?: number; links?: GraceLink[]; layout?: { y?: number; x?: Record<string, number> } }
export interface Verse { number: number; text?: string; extend?: 'start' | 'continue' | 'stop'; syllabicNext?: boolean }
export type LyricFlow = 'auto' | 'each' | 'first';
export type CurveHandle = 'from' | 'to' | 'height';
export interface Placement { x?: number; y?: number; from?: number; to?: number; fromY?: number; toY?: number; height?: number; edge?: 'from' | 'to'; spaced?: boolean }
export interface TextFace { font?: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; align?: 'start' | 'middle' | 'end' }
export interface TextFormat extends TextFace { runs?: { from: number; to: number; face: TextFace }[] }
export interface Appearance { playback?: boolean; visible?: boolean; layout?: boolean; placement?: Placement; text?: TextFormat; independentPosition?: boolean; noteSide?: 'left' | 'right'; alignment?: RhythmAlignment; alignDynamics?: boolean; arcShape?: 'long' | 'short' }
export type BeamMode = 'auto' | 'isolated' | 'break' | 'one' | 'two' | 'three' | 'join';
export type BarStyle = 'normal' | 'double' | 'final' | 'repeat-start' | 'repeat-end' | 'repeat-both';
export interface Boundary {
  style?: BarStyle; repeats?: number; break?: 'line' | 'page'; appearance?: Appearance; breakAppearance?: Appearance;
  fermata?: boolean; fermataAppearance?: Appearance;
}
export interface Ending { id?: string; start: number; end: number; fromAt?: number; toAt?: number; passes: number[]; open?: boolean; appearance?: Appearance }
export interface ImportNotice { text: string; measure?: number; lane?: string; offset?: number }
export const EXTENSION_TEXT_FIELDS = ['interNoteText', 'text', 'rehearsal'] as const;
export type ExtensionTextField = typeof EXTENSION_TEXT_FIELDS[number];
export function isExtensionText(field: string): field is ExtensionTextField {
  return EXTENSION_TEXT_FIELDS.some(value => value === field);
}

export const ORNAMENT_KINDS = ['trill', 'upper-mordent', 'lower-mordent', 'turn', 'inverted-turn', 'tremolo'] as const;
export const ORNAMENT_LABELS = ['颤音', '上波音', '下波音', '回音', '逆回音', '单音震音'] as const;
export type OrnamentKind = typeof ORNAMENT_KINDS[number];
export interface Ornament { upper?: number; lower?: number; strokes?: number; fromUpper?: boolean; delayed?: boolean; wave?: boolean }
export interface Note {
  id: string; lane: string; at: number; length: number; pitches: Pitch[];
  unpitched?: true;
  unpitchedContinuation?: true;
  ornaments?: Partial<Record<OrnamentKind, Ornament>>;
  value?: number; dots?: number; lyric?: string; accent?: boolean; staccato?: boolean;
  fermata?: boolean; dynamic?: string; text?: string; interNoteText?: string; beam?: 'break' | 'join'; split?: boolean;
  extensionText?: Record<number, Partial<Record<ExtensionTextField, string>>>;
  grace?: Partial<Record<GraceSide, GraceGroup>>;
  tenuto?: boolean; breath?: boolean | BreathShape; verses?: Verse[]; lyricFlow?: LyricFlow; rehearsal?: string;
  beams?: Record<string, BeamMode>; xmlBeams?: Record<string, number>;
}
export type BreathShape = 'upbow' | 'comma' | 'tick' | 'salzedo';
export const breathShape = (mark: Note['breath']) => mark === true ? 'upbow' : mark || undefined;
export type LaneDisplay = 'show' | 'hide' | 'rest';
export interface Lane { id: string; name: string; octave: number; shortName?: string; displayOctave?: number; parent?: string; start?: number; end?: number; splitStart?: boolean; fullNoteVolume?: boolean;
  display?: LaneDisplay; nameText?: TextFormat; shortNameText?: TextFormat; sharedNamePlacement?: Placement }
export interface Meter { numerator: number; denominator: number; groups: number[] }
export const meterLength = (meter: Meter) => meter.numerator * QUARTER * 4 / meter.denominator;
export type NumberDisplay = 'auto' | 'show' | 'hide';
export interface MeasureHighlight { color: string; opacity: number }
export const BRACKET_TYPES = ['bracket', 'brace', 'square'] as const;
export type BracketType = typeof BRACKET_TYPES[number];
export interface StaffBracket { id: string; type: BracketType; top: string; bottom: string; appearance?: Appearance }
export interface SystemSettings { visibility?: Record<string, 'show' | 'hide'>; brackets?: Record<string, StaffBracket | null> }
export interface LocalLaneName { content: string; text?: TextFormat }
export interface Measure { id?: string; length: number; system?: 'line' | 'page'; meter?: Meter; actualMeter?: Meter; pickup?: boolean;
  key?: KeySignature; meterHidden?: boolean; keyHidden?: boolean; keyAppearance?: Appearance; meterAppearance?: Appearance; tonic?: number; number?: string;
  numberStep?: number; numberLabel?: string; numberDisplay?: NumberDisplay; numberAppearance?: Appearance;
  layout?: SystemSettings; localNames?: Record<string, LocalLaneName>; highlights?: Record<string, MeasureHighlight>; repeatStart?: boolean; repeatEnd?: number;
  keepWithNext?: boolean; lockLineEnd?: boolean; route?: RouteMark[]; partBreaks?: Record<string, 'line' | 'page'>;
  lineSection?: SectionLineRule }
export const STYLE_ROLES = ['digit', 'lyric', 'title', 'credit', 'lane', 'dynamic', 'expression', 'measureNumber'] as const;
export type StyleRole = typeof STYLE_ROLES[number];
export interface TextStyle { font: string; size: number; cjkFont?: string; italic?: boolean }
export const TEXT_STYLES: Record<StyleRole, TextStyle> = {
  digit: { font: 'Arial', size: 16 }, lyric: { font: 'Times New Roman', cjkFont: 'SimSun', size: 14 }, title: { font: 'SimHei', size: 31 },
  credit: { font: 'SimSun', size: 14 }, lane: { font: 'Cambria', size: 15 }, dynamic: { font: 'Georgia', size: 14 },
  expression: { font: 'Times New Roman', cjkFont: 'SimSun', size: 14 },
  measureNumber: { font: 'Times New Roman', size: 15, italic: true }
};
export const textFontStack = (font: string, cjkFont?: string) =>
  [font, cjkFont, 'Songti SC', 'Noto Serif CJK SC'].filter(Boolean).map(family => JSON.stringify(family)).join(', ') + ', serif';
export function faceAfterEdit(format: TextFormat | undefined, before: string, after: string) {
  if (!format?.runs?.length || before === after) return format;
  let from = 0;
  while (from < Math.min(before.length, after.length) && before[from] === after[from]) from++;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - from && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
  const oldEnd = before.length - suffix;
  const delta = after.length - before.length;
  const runs = format.runs.flatMap(run => {
    if (run.to <= from) return [run];
    if (run.from >= oldEnd) return [{ ...run, from: run.from + delta, to: run.to + delta }];
    const pieces = [];
    if (run.from < from) pieces.push({ ...run, to: from });
    if (run.to > oldEnd) pieces.push({ ...run, from: oldEnd + delta, to: run.to + delta });
    return pieces;
  });
  return { ...format, runs: runs.length ? runs : undefined };
}
export const ENGRAVING_STYLE = { arc: .95, wedge: 1, divisi: 1.3, continuation: 3,
  graceBefore: 1.4, graceAfter: 2.2, graceBetween: 1.15, graceBeamGap: 1.85, graceDotLift: 2, gracePercent: 67 };
export type EngravingStyle = typeof ENGRAVING_STYLE;
export const ENGRAVING_LIMITS: Record<keyof EngravingStyle, [number, number]> = {
  arc: [.5, 3], wedge: [.5, 3], divisi: [.5, 3], continuation: [.5, 8],
  graceBefore: [.5, 12], graceAfter: [.5, 12], graceBetween: [.5, 8], graceBeamGap: [.7, 6], graceDotLift: [0, 5], gracePercent: [40, 100]
};
export const DEFAULT_SPACING = { note: 9, bar: 8, voice: 9, system: 14, lyric: 4, marginX: 56, marginY: 48 };
export const SPACING_LIMITS = {
  note: [6, 28], bar: [5, 28], voice: [2, 36], system: [6, 65],
  lyric: [0, 26], marginX: [0, 105], marginY: [0, 100],
  marginLeft: [0, 105], marginRight: [0, 105], marginTop: [0, 100], marginBottom: [0, 100]
} as const;
export const PAPER_WIDTH = 794;
export const PAPER_HEIGHT = 1123;
export interface Paper { width: number; height: number }
export interface Folio { start: number; first: boolean; position: 'top' | 'bottom'; align: 'center' | 'outside' }
export const DEFAULT_PAPER: Paper = { width: 210, height: 297 };
export const DEFAULT_FOLIO: Folio = { start: 1, first: true, position: 'bottom', align: 'center' };
export function paperSize(score: Pick<Score, 'paper'>) {
  const paper = score.paper ?? DEFAULT_PAPER;
  return { ...paper, pixelWidth: score.paper ? paper.width * 96 / 25.4 : PAPER_WIDTH,
    pixelHeight: score.paper ? paper.height * 96 / 25.4 : PAPER_HEIGHT };
}
export const SCORE_SCALE_RANGE = [25, 300] as const;
const marginAxis = { marginLeft: 'marginX', marginRight: 'marginX', marginTop: 'marginY', marginBottom: 'marginY' } as const;
export type Spacing = typeof DEFAULT_SPACING & Partial<Record<keyof typeof marginAxis, number>>;
export interface PageLayout { spacing?: Partial<Spacing>; justifyBottom?: boolean }
export const DYNAMIC_STEPS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'] as const;
export type DynamicStep = typeof DYNAMIC_STEPS[number];
export interface Span { id?: string; kind: 'tie' | 'slur' | 'crescendo' | 'diminuendo' | 'slide' | 'tremolo'; from: string; to: string; pitch?: number; targetPitch?: number; fromAt?: number; toAt?: number; lyricFlow?: LyricFlow; appearance?: Appearance; strokes?: number; dynamicText?: string; dynamicTarget?: DynamicStep }
export const TEMPO_UNITS = [384, 192, 96, 48, 24, 12] as const;
export const TEMPO_LINE_KINDS = ['accel.', 'rit.', 'rall.', 'allarg.'] as const;
export type TempoLineKind = typeof TEMPO_LINE_KINDS[number];
type TempoSettings = { override?: number; label?: string } & (
  { kind: 'metronome'; unit: number; dots: number; bpm: number; writtenRate?: string } |
  { kind: 'word'; bpm: number } | { kind: 'restore' | 'primo' } |
  { kind: 'modulation'; unit: number; dots: number; rightUnit: number; rightDots: number } |
  { kind: 'swing' | 'straight'; swingUnit: 48 | 24; ratio: number });
export type TempoMark = TempoSettings & { id: string; at: number; appearance?: Appearance };
export interface TempoLine { id: string; from: number; to: number; kind: TempoLineKind; label?: string; target?: number; percent?: number;
  lane?: string; playback?: boolean;
  dashVisible?: boolean; dashLayout?: boolean; appearance?: Appearance }
export interface Score {
  version: 1; title: string; credit: string; tonic: number; tempo: number;
  numerator: number; denominator: number; groups: number[];
  measures: Measure[]; lanes: Lane[]; notes: Note[]; spans: Span[];
  spacing?: Spacing;
  justifyBottom?: boolean;
  scalePercent?: number;
  measureNumbers?: 'auto' | 'hide';
  brackets?: StaffBracket[];
  pageLayouts?: Record<number, PageLayout>;
  lineRule?: LineRule;
  chordSymbols?: ChordSymbol[];
  titleSignatures?: { key?: boolean; meter?: boolean };
  linkedParts?: LinkedPart[];
  subtitle?: string; lyricist?: string; arranger?: string; composer?: string; copyright?: string;
  endings?: Ending[];
  importNotices?: ImportNotice[];
  boundaries?: Record<string, Boundary>;
  appearance?: Record<string, Appearance>;
  columns?: Record<number, number>;
  key?: KeySignature;
  textStyles?: Partial<Record<StyleRole, TextStyle>>;
  engravingStyle?: Partial<EngravingStyle>;
  tempoMarks?: TempoMark[];
  tempoLines?: TempoLine[];
  tuplets?: Tuplet[];
  paper?: Paper;
  folio?: Folio | false;
}
export interface Cursor { lane: string; at: number }

export function tupletAt(score: Score, lane: string, at: number) {
  const inside = (score.tuplets ?? []).filter(group => group.lane === lane && group.at <= at && at < tickEnd(group));
  const parents = new Set(inside.map(group => group.parent));
  return inside.find(group => !parents.has(group.id));
}

export const tupletWritten = (group: Tuplet) => group.written ?? group.unit * group.count;
export const tupletScale = (group?: Tuplet) => !group ? 1 : group.ratio
  ? group.ratio[0] / group.ratio[1] : group.length / tupletWritten(group);

export function tupletUnit(length: number, dots: number, count: number) {
  const ideal = length / count;
  return QUARTER * 2 ** (dots ? Math.floor(Math.log2(ideal / QUARTER) + 1e-12) : Math.ceil(Math.log2(ideal / QUARTER) - 1e-12));
}

export function createTuplet(score: Score, cursor: Cursor, written: number, dots: number, count: number, preserve?: Note) {
  if (!Number.isInteger(count) || count < 2 || count > 999) throw Error('多连音份数须为 2–999。');
  const unit = tupletUnit(written, dots, count);
  if (unit < 6) throw Error('组内书写时值短于六十四分音符，未创建。');
  if (unit > 384) throw Error('组内书写时值超过全音符，未创建。');
  const parent = tupletAt(score, cursor.lane, cursor.at);
  const [startN, startD] = rhythmFraction(cursor.at);
  const origin = startN / startD;
  const duration = written * tupletScale(parent);
  const end = tick(origin + duration);
  const length = tick(end - cursor.at);
  const bar = measureTable(score).find(bar => cursor.at >= bar.start && cursor.at < bar.end);
  const lane = score.lanes.find(lane => lane.id === cursor.lane);
  if (!bar || !lane || end > Math.min(bar.end, lane.end ?? Infinity, parent ? tickEnd(parent) : Infinity) ||
    score.lanes.some(child => child.parent === (lane.parent ?? lane.id) &&
      [child.start!, child.end!].some(at => at > cursor.at && at < end)))
    throw Error('多连音超出小节、临时声部或父组。');
  const points = Array.from({ length: count + 1 }, (_, index) => tick(origin + duration * index / count));
  points[0] = cursor.at;
  points[count] = end;
  if (points.some((at, index) => index > 0 && at <= points[index - 1])) throw Error('等分时值过小，未创建。');
  const descendants = (score.tuplets ?? []).filter(group => group.lane === lane.id && group.at < end &&
    tickEnd(group) > cursor.at && group !== parent && !(group.at <= cursor.at && tickEnd(group) >= end));
  if (descendants.length || parent && (score.tuplets ?? []).some(group => group.parent === parent.id && group.at < end && tickEnd(group) > cursor.at))
    throw Error('所选范围与已有多连音部分重叠。');
  const ratio = rhythmFraction(duration / (unit * count), 1e-13);
  const group: Tuplet = { id: uid(), ...cursor, length, unit, count, parent: parent?.id, ratio };
  const first: Note = { ...(preserve ?? {}), ...cursor, id: preserve?.id ?? uid(), length: tick(points[1] - points[0]),
    pitches: structuredClone(preserve?.pitches ?? []), unpitched: preserve?.unpitched, value: unit, dots: 0 };
  delete first.extensionText;
  if (first.beams) first.beams = Object.fromEntries(Object.entries(first.beams).filter(([at]) => Number(at) === cursor.at));
  if (first.xmlBeams) first.xmlBeams = Object.fromEntries(Object.entries(first.xmlBeams).filter(([at]) => Number(at) === cursor.at));
  cover(score, lane.id, cursor.at, end, preserve);
  if (preserve) score.notes = score.notes.filter(note => note !== preserve);
  score.notes.push(first, ...points.slice(1, -1).map((at, index) =>
    ({ id: uid(), lane: lane.id, at, length: tick(points[index + 2] - at), pitches: [], value: unit, dots: 0 })));
  (score.tuplets ??= []).push(group);
  score.notes.sort((a, b) => a.at - b.at);
  pruneTies(score);
  return group;
}

export function scoreBrackets(score: Score): StaffBracket[] {
  const lanes = score.lanes.filter(lane => !lane.parent);
  return score.brackets ?? (lanes.length ? [{ id: 'choir', type: 'bracket', top: lanes[0].id, bottom: lanes.at(-1)!.id }] : []);
}
function sameStaffBracket(a: StaffBracket | null | undefined, b: StaffBracket | null | undefined) {
  if (!a || !b) return a === b;
  return a.id === b.id && a.type === b.type && a.top === b.top && a.bottom === b.bottom &&
    (a.appearance?.visible !== false) === (b.appearance?.visible !== false) &&
    (a.appearance?.layout !== false) === (b.appearance?.layout !== false) &&
    (a.appearance?.placement?.x ?? 0) === (b.appearance?.placement?.x ?? 0);
}

export function systemBrackets(score: Score, first: number, last: number) {
  const global = new Map(scoreBrackets(score).map(item => [item.id, item]));
  const bars = score.measures.slice(first, last + 1);
  const ids = new Set([...global.keys(), ...bars.flatMap(bar => Object.keys(bar.layout?.brackets ?? {}))]);
  const local = new Set<string>();
  const conflicts: string[] = [];
  const items = [...ids].flatMap(id => {
    const values = bars.map(bar => bar.layout?.brackets?.[id]);
    const initial = values[0];
    if (initial !== undefined && values.every(value => sameStaffBracket(value, initial))) {
      local.add(id);
      return initial ? [initial] : [];
    }
    if (values.some(value => value !== undefined)) conflicts.push(id);
    const inherited = global.get(id);
    return inherited ? [inherited] : [];
  });
  return { items, local, conflicts };
}

export function systemVisibility(score: Score, first: number, last: number, start: number, end: number, hasContent: (lane: Lane) => boolean) {
  const bars = score.measures.slice(first, last + 1);
  const candidates = score.lanes.filter(lane => !lane.parent || lane.start! < end && lane.end! > start);
  const choices = new Map(candidates.map(lane => {
    const values = bars.map(bar => bar.layout?.visibility?.[lane.id]);
    return [lane.id, values.includes('show') ? 'show' : values.every(value => value === 'hide') ? 'hide' : undefined] as const;
  }));
  const visible = candidates.filter(lane => {
    const choice = choices.get(lane.id) ?? lane.display ?? 'show';
    return choice === 'show' || choice === 'rest' && hasContent(lane);
  });
  const fallback = visible.length ? undefined : candidates.find(hasContent) ?? candidates.find(lane => !lane.parent);
  if (fallback) visible.push(fallback);
  return { candidates, visible, choices, fallback };
}

export function laneNameValue(lane: Lane, field: 'name' | 'shortName', measure?: Pick<Measure, 'localNames'>) {
  return field === 'name' ? lane.name : (measure?.localNames?.[lane.id]?.content ?? lane.shortName) || lane.name;
}

export function laneNameFormat(lane: Lane, field: 'name' | 'shortName', measure?: Pick<Measure, 'localNames'>) {
  return field === 'name' ? lane.nameText : measure?.localNames?.[lane.id] ? measure.localNames[lane.id].text : lane.shortNameText;
}

export function endingRange(ending: Ending, measures: ReturnType<typeof measureTable>) {
  return { from: ending.fromAt ?? measures[ending.start].start, to: ending.toAt ?? measures[ending.end].end };
}

export function setEndingRange(score: Score, ending: Ending, from: number, to: number) {
  const measures = measureTable(score);
  const start = measures.find(item => from >= item.start && from < item.end)?.index;
  const end = measures.find(item => to > item.start && to <= item.end)?.index;
  if (start === undefined || end === undefined || !Number.isInteger(from) || !Number.isInteger(to) || from >= to)
    throw Error('房子的起点必须早于终点，且在乐谱范围内。');
  if (score.endings?.some(other => {
    const range = endingRange(other, measures);
    return other !== ending && from < range.to && to > range.from;
  })) throw Error('房子范围重叠，请调整端点。');
  Object.assign(ending, { start, end, fromAt: from === measures[start].start ? undefined : from,
    toAt: to === measures[end].end ? undefined : to });
}

export function pageLayout(score: Score, page: number) {
  const settings = score.pageLayouts?.[page];
  const global = { ...DEFAULT_SPACING, ...score.spacing };
  const local = settings?.spacing;
  const margin = (edge: keyof typeof marginAxis) => local?.[edge] ?? local?.[marginAxis[edge]] ?? global[edge] ?? global[marginAxis[edge]];
  return {
    spacing: { ...global, ...local, marginLeft: margin('marginLeft'), marginRight: margin('marginRight'),
      marginTop: margin('marginTop'), marginBottom: margin('marginBottom') },
    justifyBottom: settings?.justifyBottom ?? score.justifyBottom ?? true
  };
}

export const BAR_STYLES: BarStyle[] = ['normal', 'double', 'final', 'repeat-start', 'repeat-end', 'repeat-both'];
export const BEAM_MODES: BeamMode[] = ['auto', 'isolated', 'break', 'one', 'two', 'three', 'join'];
export const startsRepeat = (style: BarStyle) => style === 'repeat-start' || style === 'repeat-both';
export const endsRepeat = (style: BarStyle) => style === 'repeat-end' || style === 'repeat-both';

export function boundaryAt(score: Score, index: number): Boundary & { style: BarStyle } {
  const right = score.measures[index];
  const left = score.measures[index - 1];
  const saved = score.boundaries?.[index];
  const style = saved?.style ?? (right?.repeatStart
    ? left?.repeatEnd !== undefined ? 'repeat-both' : 'repeat-start'
    : left?.repeatEnd !== undefined ? 'repeat-end' : index === score.measures.length ? 'final' : 'normal');
  return {
    ...saved, style,
    repeats: endsRepeat(style) ? saved?.repeats ?? (saved?.style === undefined && left?.repeatEnd !== undefined ? left.repeatEnd - 1 : 0) : undefined,
    break: saved && Object.hasOwn(saved, 'break') ? saved.break : right?.system
  };
}

export function setBoundaryStyle(score: Score, index: number, style: BarStyle, merge = false) {
  const previous = boundaryAt(score, index);
  if ((index === 0 && endsRepeat(style)) || (index === score.measures.length && startsRepeat(style)))
    throw Error('这个边界没有对应的反复段。');
  if (merge && (style === 'repeat-start' && endsRepeat(previous.style) || style === 'repeat-end' && startsRepeat(previous.style)))
    style = 'repeat-both';
  const target = (score.boundaries ??= {})[index] ??= {};
  target.style = style;
  target.repeats = endsRepeat(style) ? previous.repeats ?? 0 : undefined;
}

export function setBoundaryBreak(score: Score, index: number, value?: Boundary['break']) {
  if (index <= 0 || index >= score.measures.length) throw Error('谱首和谱尾不能强制换行或换页。');
  const target = (score.boundaries ??= {})[index] ??= {};
  if (value) target.break = value;
  else delete target.break;
  delete score.measures[index].system;
}

export function noteVerses(note: Note): Verse[] {
  return note.verses?.some(verse => verse.number === 1) || !note.lyric
    ? note.verses ?? [] : [{ number: 1, text: note.lyric }, ...(note.verses ?? [])];
}

export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function defaultGroups(numerator: number, denominator: number): number[] {
  if (denominator === 8 && numerator >= 6 && numerator % 3 === 0)
    return Array.from({ length: numerator / 3 }, () => 3);
  if (denominator === 8 && numerator % 2 && numerator > 3)
    return [...Array.from({ length: (numerator - 3) / 2 }, () => 2), 3];
  return Array.from({ length: numerator }, () => 1);
}

export function newScore(numerator = 4, denominator = 4, pickup = 0): Score {
  const length = numerator * QUARTER * 4 / denominator;
  return {
    version: 1, title: '未命名合唱谱', credit: '', tonic: 0, tempo: 88, numerator, denominator,
    groups: defaultGroups(numerator, denominator),
    measures: [...(pickup ? [{ length: pickup, pickup: true }] : []), ...Array.from({ length: 4 }, () => ({ length }))],
    lanes: [
      { id: 'S', name: 'S.', octave: 4 }, { id: 'A', name: 'A.', octave: 4 },
      { id: 'T', name: 'T.', octave: 3 }, { id: 'B', name: 'B.', octave: 3 }
    ], notes: [], spans: []
  };
}

export function measureTable(score: Score) {
  let at = 0;
  let meter: Meter = { numerator: score.numerator, denominator: score.denominator, groups: score.groups };
  let key = score.key ?? keyForTonic(score.tonic);
  let number = 0;
  let renumbering = false;
  return score.measures.map((measure, index) => {
    const start = at;
    at = tick(at + measure.length);
    meter = measure.meter ?? meter;
    key = measure.key ?? (measure.tonic === undefined ? key : keyForTonic(measure.tonic));
    const pickup = measure.pickup ?? (index === 0 && measure.length < meterLength(meter));
    const numberStep = measure.numberStep ?? (pickup && index === 0 ? 0 : 1);
    renumbering ||= measure.numberStep !== undefined;
    number += numberStep;
    const original = renumbering ? undefined : measure.number;
    if (original && /^-?\d+$/.test(original) && Number.isSafeInteger(Number(original))) number = Number(original);
    return { ...measure, meter, key, pickup, tonic: keyTonic(key), index, number: measure.numberLabel ?? original ?? number, numberStep, sequence: number, start, end: at };
  });
}

export function beatStarts(_score: Score, measure: ReturnType<typeof measureTable>[number]): number[] {
  const { numerator, denominator, groups } = measure.pickup ? measure.meter : measure.actualMeter ?? measure.meter;
  const unit = QUARTER * 4 / denominator;
  let offset = measure.pickup ? measure.length - numerator * unit : 0;
  const starts: number[] = [];
  for (let i = 0; offset < measure.length; i++) {
    if (offset >= 0) starts.push(tick(measure.start + offset));
    offset += groups[i % groups.length] * unit;
  }
  return starts;
}

export function setMeasureLength(score: Score, index: number, length: number, keepMusic: boolean) {
  const old = measureTable(score)[index];
  const delta = length - old.length;
  if (!delta) return;
  const cut = tick(old.start + length);
  if (delta < 0 && score.tuplets?.some(group => group.at >= old.start && group.at < old.end &&
    (group.at < cut && tickEnd(group) > cut || !keepMusic && tickEnd(group) > cut)))
    throw Error('小节调整会截断已有多连音组。');
  if (delta < 0 && keepMusic && score.notes.some(note => note.at < old.end && tickEnd(note) > cut && (note.pitches.length || note.unpitched))) {
    if (score.measures.length >= 600) throw Error('已达到 600 小节，无法插入重划的小节。');
    const bar = score.measures[index];
    bar.length = length;
    const closing = bar.route?.filter(mark => !routeAtStart(mark));
    if (closing?.length) bar.route = bar.route?.filter(routeAtStart);
    score.measures.splice(index + 1, 0, { length: -delta, pickup: false, repeatEnd: bar.repeatEnd,
      route: closing?.length ? closing : undefined, lineSection: bar.lineSection,
      keepWithNext: bar.keepWithNext, lockLineEnd: bar.lockLineEnd });
    if (bar.lockLineEnd) { delete bar.lockLineEnd; bar.keepWithNext = true; }
    delete bar.repeatEnd;
    if (score.boundaries) score.boundaries = Object.fromEntries(Object.entries(score.boundaries).map(([key, value]) => [Number(key) > index ? Number(key) + 1 : key, value]));
    for (const ending of score.endings ?? []) {
      if (ending.start > index || ending.start === index && (ending.fromAt ?? old.start) >= cut) ending.start++;
      if (ending.end > index || ending.end === index && (ending.toAt ?? old.end) > cut) ending.end++;
      else if (ending.end === index && ending.toAt === cut) delete ending.toAt;
    }
    for (const notice of score.importNotices ?? []) if (notice.measure !== undefined && notice.measure > index) notice.measure++;
    return;
  }
  const at = (time: number) => time >= old.end ? tick(time + delta) : delta < 0 ? Math.min(cut, time) : time;
  const ticks = <Value>(entries: Record<number, Value> | undefined) => entries && Object.fromEntries(Object.entries(entries).map(([key, value]) => [at(Number(key)), value]));
  score.measures[index].length = length;
  score.notes = score.notes.filter(note => {
    const start = at(note.at);
    const length = tick(at(tickEnd(note)) - start);
    if (length <= 0) return false;
    if (length !== note.length) { delete note.value; delete note.dots; }
    Object.assign(note, { at: start, length, beams: ticks(note.beams), xmlBeams: ticks(note.xmlBeams) });
    return true;
  });
  for (const lane of score.lanes) if (lane.parent) { lane.start = at(lane.start!); lane.end = at(lane.end!); }
  const removed = new Set(score.lanes.filter(lane => lane.parent && lane.start === lane.end).map(lane => lane.id));
  if (removed.size) removeLanes(score, removed);
  for (const span of score.spans) {
    if (span.fromAt !== undefined) span.fromAt = at(span.fromAt);
    if (span.toAt !== undefined) span.toAt = at(span.toAt);
  }
  pruneTies(score);
  for (const ending of score.endings ?? []) {
    if (ending.fromAt !== undefined) ending.fromAt = at(ending.fromAt);
    if (ending.toAt !== undefined) ending.toAt = at(ending.toAt);
  }
  const measures = measureTable(score);
  moveTempoAnchors(score, at, at, () => false, measures.at(-1)!.end);
  moveChordAnchors(score, at, time => delta < 0 && time >= cut && time < old.end);
  score.endings = score.endings?.filter(ending => {
    const { from, to } = endingRange(ending, measures);
    if (from >= to || from >= measures[ending.start].end || to <= measures[ending.end].start) return false;
    if (to === measures[ending.end].end) delete ending.toAt;
    return true;
  });
  score.columns = ticks(score.columns);
  if (score.columns) delete score.columns[measures.at(-1)!.end];
  if (score.appearance) score.appearance = Object.fromEntries(Object.entries(score.appearance).map(([key, value]) => {
    const parts = JSON.parse(key);
    if (['pitch', 'extension', 'generated-tie', 'divisi-brace'].includes(parts[0]) || parts[0] === 'lane-name' && parts[3] !== 'name') parts[2] = at(parts[2]);
    return [JSON.stringify(parts), value];
  }));
}

export function removeLanes(score: Score, ids: Set<string>) {
  const order = score.lanes.filter(lane => !lane.parent).map(lane => lane.id);
  score.lanes = score.lanes.filter(lane => !ids.has(lane.id) && (!lane.parent || !ids.has(lane.parent)));
  const remaining = new Set(score.lanes.map(lane => lane.id));
  score.linkedParts = score.linkedParts?.flatMap(part => {
    const lanes = part.lanes.filter(id => remaining.has(id));
    return lanes.length ? [{ ...part, lanes }] : [];
  });
  const partIds = new Set(score.linkedParts?.map(part => part.id));
  const keepBracket = (item: StaffBracket) => {
    const a = order.indexOf(item.top), b = order.indexOf(item.bottom);
    const voices = order.slice(Math.min(a, b), Math.max(a, b) + 1).filter(id => remaining.has(id));
    return voices.length ? { ...item, top: voices[0], bottom: voices.at(-1)! } : undefined;
  };
  if (score.brackets) score.brackets = score.brackets.flatMap(item => keepBracket(item) ?? []);
  for (const bar of score.measures) {
    if (bar.partBreaks) for (const id of Object.keys(bar.partBreaks)) if (!partIds.has(id)) delete bar.partBreaks[id];
    for (const map of [bar.layout?.visibility, bar.localNames]) if (map)
      for (const id of Object.keys(map)) if (!remaining.has(id)) delete map[id];
    if (bar.layout?.brackets) for (const [id, bracket] of Object.entries(bar.layout.brackets)) if (bracket) {
      const kept = keepBracket(bracket);
      if (kept) bar.layout.brackets[id] = kept;
      else delete bar.layout.brackets[id];
    }
  }
  score.notes = score.notes.filter(note => remaining.has(note.lane));
  score.chordSymbols = score.chordSymbols?.filter(symbol => remaining.has(symbol.lane));
  if (score.tuplets) score.tuplets = score.tuplets.filter(group => remaining.has(group.lane));
  for (const measure of score.measures) if (measure.highlights) {
    for (const lane of Object.keys(measure.highlights)) if (!remaining.has(lane)) delete measure.highlights[lane];
    if (!Object.keys(measure.highlights).length) delete measure.highlights;
  }
  if (score.appearance) for (const key of Object.keys(score.appearance))
    if ((key.startsWith('["lane-name",') || key.startsWith('["divisi-brace",')) && !remaining.has(JSON.parse(key)[1])) delete score.appearance[key];
  score.importNotices = score.importNotices?.filter(notice => !notice.lane || remaining.has(notice.lane));
  pruneTies(score);
}

export const dotted = (value: number, dots: number) => value * (2 - 2 ** -dots);
export const sound = (pitch: Pitch, tonic: number) =>
  (pitch.octave + 1) * 12 + tonic + [0, 2, 4, 5, 7, 9, 11][pitch.degree - 1] + pitch.alter;
export function tonicAt(score: Score, at: number) {
  return (measureTable(score).find(measure => at < measure.end)?.tonic ?? score.tonic);
}
export const noteAt = (score: Score, cursor: Cursor) => score.notes.find(
  note => note.lane === cursor.lane && note.at <= cursor.at && cursor.at < tickEnd(note)
);

export function pruneTies(score: Score) {
  const notes = new Map(score.notes.map(note => [note.id, note]));
  score.spans = score.spans.filter(span => {
    const from = notes.get(span.from);
    const to = notes.get(span.to);
    if (!from || !to || from.lane !== to.lane) return false;
    if (span.kind === 'slur' || span.kind === 'slide' || span.kind === 'tremolo')
      return from.pitches.length && to.pitches.length &&
        (span.kind !== 'tremolo' || tickEnd(from) === to.at && from.length === to.length &&
          from.pitches.length === 1 && to.pitches.length === 1) &&
        (span.kind !== 'slide' || !!from.pitches[span.pitch ?? 0] && !!to.pitches[span.targetPitch ?? 0]);
    if (span.kind !== 'tie') return (span.fromAt ?? from.at) < (span.toAt ?? to.at);
    const first = from.pitches[span.pitch!];
    const last = to.pitches[span.targetPitch!];
    return first && last && tickEnd(from) === to.at
      && sound(first, tonicAt(score, from.at)) === sound(last, tonicAt(score, to.at));
  });
}

export function editTiedPitch(score: Score, note: Note, index: number, edit: (pitch: Pitch) => void, edited = new Set<Pitch>()) {
  editTiedPitches(score, [{ note, index }], edit, edited);
}

export function editTiedPitches(score: Score, targets: { note: Note; index: number }[], edit: (pitch: Pitch) => void, edited = new Set<Pitch>()) {
  const apply = tiedPitchEditor(score, edited);
  for (const { note, index } of targets) apply(note, index, edit);
}
export function tiedPitchEditor(score: Score, edited = new Set<Pitch>(), changedNote?: (note: Note) => void) {
  const byId = new Map(score.notes.map(item => [item.id, item]));
  const measures = measureTable(score);
  const tonicOf = (note: Note) => measures.find(measure => measure.start <= note.at && note.at < measure.end)!.tonic;
  const related = new Map<string, Map<number, [string, number][]>>();
  const add = (from: string, pitch: number, to: string, target: number) => {
    if (!related.has(from)) related.set(from, new Map());
    const pitches = related.get(from)!;
    if (!pitches.has(pitch)) pitches.set(pitch, []);
    pitches.get(pitch)!.push([to, target]);
  };
  for (const span of score.spans) if (span.kind === 'tie') {
    add(span.from, span.pitch!, span.to, span.targetPitch!);
    add(span.to, span.targetPitch!, span.from, span.pitch!);
  }
  return (note: Note, index: number, edit: (pitch: Pitch) => void) => {
    const original = byId.get(note.id)?.pitches[index];
    if (!original || edited.has(original)) return;
    const changed = { ...original };
    edit(changed);
    const startTonic = tonicOf(note);
    const target = sound(changed, startTonic);
    const pending: [string, number][] = [[note.id, index]];
    while (pending.length) {
      const [id, pitchIndex] = pending.pop()!;
      const item = byId.get(id);
      const pitch = item?.pitches[pitchIndex];
      if (!item || !pitch || edited.has(pitch)) continue;
      edited.add(pitch);
      const tonic = tonicOf(item);
      const courtesy = pitch.courtesy;
      Object.assign(pitch, tonic === startTonic ? changed : pitchAtSound(target, tonic), { courtesy });
      changedNote?.(item);
      pending.push(...(related.get(id)?.get(pitchIndex) ?? []));
    }
  };
}

export function pitchAtSound(midi: number, tonic: number, preferFlat = false): Pitch {
  const octave = Math.floor((midi - tonic) / 12) - 1;
  const chromatic = midi - (octave + 1) * 12 - tonic;
  const scale = [0, 2, 4, 5, 7, 9, 11];
  let index = scale.length - 1;
  while (scale[index] > chromatic) index--;
  if (preferFlat && scale[index] !== chromatic)
    return { degree: index + 2, octave, alter: chromatic - scale[index + 1] };
  return { degree: index + 1, octave, alter: chromatic - scale[index] };
}

export function sliceExtensionText(source: Note, target: Note) {
  const rows = Object.entries(source.extensionText ?? {}).flatMap(([offset, text]) => {
    const relative = tick(source.at + Number(offset) - target.at);
    if (relative === 0) Object.assign(target, text);
    return relative > 0 && relative < target.length ? [[relative, { ...text }]] : [];
  });
  target.extensionText = rows.length ? Object.fromEntries(rows) : undefined;
}

function tailOf(note: Note, start: number): Note {
  const tail: Note = {
    id: uid(), lane: note.lane, at: start, length: tick(tickEnd(note) - start),
    pitches: structuredClone(note.pitches), lyricFlow: note.lyricFlow, unpitched: note.unpitched,
    unpitchedContinuation: note.unpitched
  };
  if (note.grace?.after) tail.grace = { after: structuredClone(note.grace.after) };
  if (note.extensionText) sliceExtensionText(note, tail);
  return tail;
}

function respellTail(score: Score, tail: Note, original: Note) {
  const before = tonicAt(score, original.at);
  const after = tonicAt(score, tail.at);
  if (before !== after) respellNote(tail, before, after);
}

export function respellNote(note: Note, before: number, after: number) {
  const transpose = (pitch: Pitch) => ({ ...pitchAtSound(sound(pitch, before), after), courtesy: pitch.courtesy });
  note.pitches = note.pitches.map(transpose);
  for (const side of GRACE_SIDES) for (const event of note.grace?.[side]?.notes ?? []) event.pitches = event.pitches.map(transpose);
}

function shorten(note: Note, end: number) {
  note.length = tick(end - note.at);
  if (note.grace?.after) {
    delete note.grace.after;
    if (!note.grace.before) delete note.grace;
  }
  if (note.extensionText) sliceExtensionText(note, note);
  delete note.value;
  delete note.dots;
}

function splitNote(score: Score, note: Note, at: number): Note {
  if (at === note.at) return note;
  const tail = tailOf(note, at);
  respellTail(score, tail, note);
  shorten(note, at);
  for (const span of score.spans) if (span.kind === 'tie' && span.from === note.id) span.from = tail.id;
  note.pitches.forEach((_, index) => {
    score.spans.push({ kind: 'tie', from: note.id, to: tail.id, pitch: index, targetPitch: index, lyricFlow: note.lyricFlow });
  });
  score.notes.push(tail);
  return tail;
}

export function isolateFragment(score: Score, displayed: Note, at: number, length: number): Note {
  const stored = score.notes.includes(displayed);
  if (!stored) {
    const rest = { id: uid(), lane: displayed.lane, at, length, pitches: [] };
    score.notes.push(rest);
    return rest;
  }
  const note = splitNote(score, displayed, at);
  if (tick(at + length) < tickEnd(note)) splitNote(score, note, tick(at + length));
  return note;
}

function cover(score: Score, lane: string, start: number, end: number, keep?: Note) {
  if (start >= end) return;
  score.notes = score.notes.flatMap(note => {
    if (note === keep || note.lane !== lane || note.at >= end || tickEnd(note) <= start) return [note];
    const tail = tickEnd(note) > end ? tailOf(note, end) : null;
    if (tail) {
      delete tail.unpitchedContinuation;
      respellTail(score, tail, note);
      for (const span of score.spans) {
        if (span.kind === 'tie' && span.from === note.id) span.from = tail.id;
        if (span.kind === 'tie' && span.to === note.id && keep?.id === span.from) span.to = tail.id;
      }
    }
    if (note.at < start) {
      shorten(note, start);
      return tail ? [note, tail] : [note];
    }
    return tail ? [tail] : [];
  });
}

export function eraseInterval(score: Score, lane: string, start: number, end: number) {
  cover(score, lane, start, end);
  pruneTies(score);
}

export function insertCopiedNote(score: Score, note: Note) {
  const lane = score.lanes.find(item => item.id === note.lane);
  if (!lane || note.at < (lane.start ?? 0) || lane.end !== undefined && tickEnd(note) > lane.end)
    throw Error('粘贴范围超出临时副线或目标声部。');
  while (measureTable(score).at(-1)!.end < tickEnd(note)) {
    if (score.measures.length >= 600) throw Error('粘贴超过 600 小节。');
    addMeasure(score);
  }
  cover(score, note.lane, note.at, tickEnd(note));
  score.notes.push(note);
}

export function resizeNote(score: Score, note: Note, value: number, dots: number) {
  const group = tupletAt(score, note.lane, note.at);
  const end = rhythmicEnd(score, note, dotted(value, dots) * tupletScale(group), group);
  const length = tick(end - note.at);
  checkTupletEdit(score, note, end, group);
  const lane = score.lanes.find(item => item.id === note.lane)!;
  if (lane.end !== undefined && end > lane.end) throw new Error('时值超出临时副线范围。');
  while (end > measureTable(score).at(-1)!.end) addMeasure(score);
  cover(score, note.lane, tickEnd(note), end, note);
  Object.assign(note, { length, value, dots });
  if (note.extensionText) sliceExtensionText(note, note);
  pruneTies(score);
}

export function moveSpanEnd(score: Score, index: number, endpoint: 'from' | 'to', direction: number) {
  const span = score.spans[index];
  const current = score.notes.find(note => note.id === span[endpoint])!;
  const lane = score.notes.filter(note => note.lane === current.lane &&
    (span.kind === 'crescendo' || span.kind === 'diminuendo' || note.pitches.length)).sort((a, b) => a.at - b.at);
  const candidate = lane[lane.indexOf(current) + direction];
  if (!candidate) throw new Error('该方向没有可用的端点。');
  setSpanEnd(score, index, endpoint, candidate);
}

export function setSpanTime(score: Score, index: number, endpoint: 'from' | 'to', at: number) {
  const span = score.spans[index];
  const from = score.notes.find(note => note.id === span.from)!;
  const to = score.notes.find(note => note.id === span.to)!;
  const lane = score.lanes.find(lane => lane.id === from.lane)!;
  const end = lane.end ?? measureTable(score).at(-1)!.end;
  if (!Number.isFinite(at) || at < (lane.start ?? 0) || at > end ||
    (endpoint === 'from' ? at >= (span.toAt ?? to.at) : at <= (span.fromAt ?? from.at)))
    throw Error('端点须在所属声部内，且起点早于终点。');
  if (endpoint === 'from') span.fromAt = at;
  else span.toAt = at;
}

export function setSpanEnd(score: Score, index: number, endpoint: 'from' | 'to', candidate: Note, pitchIndex?: number) {
  const span = score.spans[index];
  const other = score.notes.find(note => note.id === span[endpoint === 'from' ? 'to' : 'from'])!;
  if (span.kind === 'crescendo' || span.kind === 'diminuendo') {
    if (candidate.lane !== other.lane) throw Error('端点须在所属声部内。');
    setSpanTime(score, index, endpoint, candidate.at);
    span[endpoint] = candidate.id;
    if (endpoint === 'from') delete span.fromAt;
    else delete span.toAt;
    return;
  }
  if (candidate.lane !== other.lane || !candidate.pitches.length ||
    (endpoint === 'from' ? candidate.at >= other.at : candidate.at <= other.at))
    throw new Error('端点必须吸附到同声部的有效音符。');
  if (span.kind === 'tie') {
    const first = endpoint === 'from' ? candidate : other;
    const last = endpoint === 'to' ? candidate : other;
    const fixed = other.pitches[(endpoint === 'from' ? span.targetPitch : span.pitch)!];
    const matches = (pitch: Pitch) => sound(pitch, tonicAt(score, candidate.at)) === sound(fixed, tonicAt(score, other.at));
    const match = pitchIndex === undefined ? candidate.pitches.findIndex(matches) :
      candidate.pitches[pitchIndex] && matches(candidate.pitches[pitchIndex]) ? pitchIndex : -1;
    if (match < 0 || tickEnd(first) !== last.at) throw new Error('同音线只能连接时间紧接、音高相同的音。');
    if (endpoint === 'from') span.pitch = match;
    else span.targetPitch = match;
  } else if (span.kind === 'slur' || span.kind === 'slide') {
    const key = endpoint === 'from' ? 'pitch' : 'targetPitch';
    if (pitchIndex !== undefined && candidate.pitches[pitchIndex]) span[key] = pitchIndex;
    else delete span[key];
  } else if (span.kind === 'tremolo') {
    const first = endpoint === 'from' ? candidate : other;
    const last = endpoint === 'to' ? candidate : other;
    if (tickEnd(first) !== last.at || first.length !== last.length || first.pitches.length !== 1 || last.pitches.length !== 1)
      throw Error('双音震音需要两个相邻、等时值的单音。');
  }
  span[endpoint] = candidate.id;
}

export function addMeasure(score: Score) {
  const { numerator, denominator } = measureTable(score).at(-1)!.meter;
  score.measures.push({ length: numerator * QUARTER * 4 / denominator });
}

function blankMeasure(bar: ReturnType<typeof measureTable>[number]): Measure {
  const measure: Measure = structuredClone({ length: bar.length, meter: bar.meter, actualMeter: bar.actualMeter, pickup: bar.pickup,
    key: bar.key, meterHidden: bar.meterHidden, keyHidden: bar.keyHidden, numberStep: bar.numberStep,
    numberDisplay: bar.numberDisplay, highlights: bar.highlights });
  if (bar.pickup) {
    measure.length = meterLength(bar.meter);
    delete measure.pickup;
    delete measure.actualMeter;
  }
  return measure;
}

export const sameMeter = (a: Meter, b: Meter) => a.numerator === b.numerator && a.denominator === b.denominator && a.groups.join() === b.groups.join();

function inheritBarContext(score: Score, index: number, bar: ReturnType<typeof measureTable>[number]) {
  const measure = score.measures[index];
  if (!measure) return;
  const current = measureTable(score)[index];
  if (!sameKey(current.key, bar.key)) measure.key = bar.key;
  if (!sameMeter(current.meter, bar.meter)) measure.meter = bar.meter;
  if (current.pickup !== bar.pickup) measure.pickup = bar.pickup;
}

function saveEditedBoundaries(score: Score, entries: [number, Boundary][]) {
  const count = score.measures.length;
  for (const bar of score.measures) {
    delete bar.repeatStart; delete bar.repeatEnd; delete bar.system;
  }
  const result: Record<string, Boundary> = {};
  for (const [index, saved] of entries) {
    const fallback = index === count ? 'final' : 'normal';
    let style = saved.style ?? fallback;
    if (index === 0 && endsRepeat(style)) style = startsRepeat(style) ? 'repeat-start' : fallback;
    if (index === count && startsRepeat(style)) style = endsRepeat(style) ? 'repeat-end' : fallback;
    const hardBreak = index > 0 && index < count ? saved.break : undefined;
    if (style !== fallback || hardBreak || saved.appearance || saved.fermata || saved.fermataAppearance)
      result[index] = { ...saved, style, break: hardBreak, repeats: endsRepeat(style) ? saved.repeats : undefined };
  }
  score.boundaries = Object.keys(result).length ? result : undefined;
}

type TimeMap = (at: number) => number;
function moveTempoAnchors(score: Score, start: TimeMap, end: TimeMap, removed: (at: number) => boolean, limit: number) {
  if (score.tuplets) {
    const bars = measureTable(score);
    score.tuplets = score.tuplets.flatMap(group => {
      if (removed(group.at)) return [];
      const at = tick(start(group.at)), finish = tick(end(tickEnd(group)));
      if (Math.abs(finish - at - group.length) > 1e-7 || !bars.some(bar => bar.start <= at && finish <= bar.end))
        throw Error('不能在多连音组中间改变小节结构。');
      return [{ ...group, at }];
    });
  }
  if (score.tempoMarks) score.tempoMarks = [...new Map(score.tempoMarks.slice().sort((a, b) => a.at - b.at)
    .filter(mark => !removed(mark.at) && start(mark.at) < limit).map(mark => {
      const at = start(mark.at);
      return [`${at}:${mark.kind === 'swing' || mark.kind === 'straight'}`, { ...mark, at }] as const;
    })).values()];
  if (score.tempoLines) score.tempoLines = score.tempoLines.map(line => ({ ...line, from: start(line.from), to: end(line.to) }))
    .filter(line => line.from < line.to && line.to <= limit);
}
type SplitAnchor = { from: number; id: string };
function keepBeamAnchors(source: Note, tail: Note, cutoff: number, keepHead: boolean) {
  const part = <T>(anchors: Record<string, T> | undefined, right: boolean) => anchors && Object.fromEntries(
    Object.entries(anchors).filter(([at]) => (Number(at) >= cutoff) === right));
  tail.beams = part(source.beams, true);
  tail.xmlBeams = part(source.xmlBeams, true);
  if (keepHead) {
    source.beams = part(source.beams, false);
    source.xmlBeams = part(source.xmlBeams, false);
  }
}
function moveChordAnchors(score: Score, start: TimeMap, removed: (at: number) => boolean) {
  score.chordSymbols = score.chordSymbols?.flatMap(symbol => removed(symbol.at) ? [] : [{ ...symbol, at: start(symbol.at) }]);
}

function moveAnchors(score: Score, oldBars: ReturnType<typeof measureTable>, start: TimeMap, end: TimeMap,
  removedAt: (at: number) => boolean, splitAnchors: Map<string, SplitAnchor>) {
  moveTempoAnchors(score, start, end, removedAt, measureTable(score).at(-1)!.end);
  moveChordAnchors(score, start, removedAt);
  const timing = <T>(settings: Record<number, T> | undefined) => settings && Object.fromEntries(
    Object.entries(settings).filter(([at]) => !removedAt(Number(at))).map(([at, value]) => [start(Number(at)), value]));
  const notes = new Map(score.notes.map(note => [note.id, note]));
  for (const note of score.notes) {
    note.beams = timing(note.beams);
    note.xmlBeams = timing(note.xmlBeams);
  }
  score.columns = timing(score.columns);
  for (const span of score.spans) {
    if (span.fromAt !== undefined) span.fromAt = start(span.fromAt);
    if (span.toAt !== undefined) span.toAt = end(span.toAt);
  }
  for (const lane of score.lanes) if (lane.parent) { lane.start = start(lane.start!); lane.end = end(lane.end!); }
  const emptyLanes = new Set(score.lanes.filter(lane => lane.parent && lane.start! >= lane.end!).map(lane => lane.id));
  if (emptyLanes.size) removeLanes(score, emptyLanes);
  pruneTies(score);
  const endings = score.endings ?? [];
  score.endings = undefined;
  for (const ending of endings) {
    const from = start(endingRange(ending, oldBars).from), to = end(endingRange(ending, oldBars).to);
    if (from < to) {
      setEndingRange(score, ending, from, to);
      (score.endings ??= []).push(ending);
    }
  }
  if (score.appearance) {
    const entries = [];
    for (const [key, value] of Object.entries(score.appearance)) {
      let parts: (string | number)[];
      try { parts = JSON.parse(key); } catch { continue; }
      const [kind, id, at, side] = parts;
      if (kind === 'mark' && !notes.has(String(id))) continue;
      if (kind === 'pitch' || kind === 'extension' || kind === 'generated-tie') {
        const split = splitAnchors.get(String(id));
        if (split && Number(at) >= split.from) parts[1] = split.id;
        const rest = /^rest:(.+):(\d+(?:\.\d+)?)$/.exec(String(id));
        if (removedAt(Number(at)) || !notes.has(String(parts[1])) && !rest) continue;
        if (rest && !notes.has(String(id))) {
          if (removedAt(Number(rest[2])) || emptyLanes.has(rest[1])) continue;
          parts[1] = 'rest:' + rest[1] + ':' + start(Number(rest[2]));
        }
        parts[2] = start(Number(at));
      } else if (kind === 'lane-name' && side !== 'name' || kind === 'divisi-brace') {
        if (removedAt(Number(at)) && (kind !== 'divisi-brace' || !score.lanes.some(lane => lane.parent === id &&
          (side === 'end' ? lane.end : lane.start) === start(Number(at))))) continue;
        parts[2] = kind === 'divisi-brace' && side === 'end' ? end(Number(at)) : start(Number(at));
      }
      entries.push([JSON.stringify(parts), value] as const);
    }
    score.appearance = Object.fromEntries(entries);
  }
  score.notes.sort((a, b) => a.at - b.at);
}

export function insertBlankMeasure(score: Score, anchor: number, after: boolean) {
  if (score.measures.length >= 600) throw Error('乐谱已达到 600 小节。');
  const bars = measureTable(score);
  const template = bars[anchor];
  if (!template) throw Error('请选择插入位置。');
  const index = anchor + Number(after);
  const at = bars[index]?.start ?? bars.at(-1)!.end;
  const bar = blankMeasure(template);
  const prior = bars[index - 1] ?? { key: score.key ?? keyForTonic(score.tonic), meter: score };
  if (!score.measures[anchor].meter && sameMeter(prior.meter, template.meter)) delete bar.meter;
  if (!score.measures[anchor].key && sameKey(prior.key, template.key)) delete bar.key;
  const step = template.pickup ? 1 : template.sequence - (bars[anchor - 1]?.sequence ?? 0);
  bar.numberStep = step;
  const boundaries = Array.from({ length: bars.length + 1 }, (_, i) => boundaryAt(score, i));
  const splitAnchors = new Map<string, SplitAnchor>();
  for (const note of [...score.notes]) if (note.at < at && tickEnd(note) > at) {
    const tail = splitNote(score, note, at);
    keepBeamAnchors(note, tail, at, true);
    splitAnchors.set(note.id, { from: at, id: tail.id });
  }
  const forward = (time: number) => time >= at ? tick(time + bar.length) : time;
  const forwardEnd = (time: number) => time > at ? tick(time + bar.length) : time;
  for (const note of score.notes) note.at = forward(note.at);
  const beforeLayout = score.measures[index - 1]?.layout, afterLayout = score.measures[index]?.layout;
  if (beforeLayout && afterLayout) {
    const visibility = Object.fromEntries(Object.entries(beforeLayout.visibility ?? {}).filter(([id, value]) => afterLayout.visibility?.[id] === value));
    const brackets = Object.fromEntries(Object.entries(beforeLayout.brackets ?? {}).filter(([id, value]) => sameStaffBracket(afterLayout.brackets?.[id], value)));
    if (Object.keys(visibility).length || Object.keys(brackets).length) bar.layout = structuredClone({ visibility, brackets });
  }
  const section = score.measures[index - 1]?.lineSection;
  if (section && score.measures[index]?.lineSection?.id === section.id) bar.lineSection = { ...section };
  if (score.measures[index - 1]?.keepWithNext && !boundaryAt(score, index).break) bar.keepWithNext = true;
  score.measures.splice(index, 0, bar);
  if (bars[index]) {
    inheritBarContext(score, index + 1, bars[index]);
    const following = score.measures[index + 1];
    if (following.pickup) following.numberStep = 1;
    else if (following.numberStep === undefined) {
      const oldStep = bars[index].sequence - (bars[index - 1]?.sequence ?? 0);
      if (oldStep !== 1) following.numberStep = oldStep;
    }
  }
  const cut = boundaries[index];
  const entries: [number, Boundary][] = boundaries.flatMap((boundary, i) => i === index ? [] : [[i > index ? i + 1 : i, boundary]]);
  if (endsRepeat(cut.style)) entries.push([index, { ...cut, style: 'repeat-end', break: undefined, breakAppearance: undefined }]);
  else if (index < bars.length && (cut.style === 'double' || cut.style === 'final'))
    entries.push([index, { style: cut.style, appearance: cut.appearance, fermata: cut.fermata, fermataAppearance: cut.fermataAppearance }]);
  entries.push([index + 1, { ...cut, style: index === bars.length
    ? cut.style === 'repeat-end' ? 'final' : cut.style
    : startsRepeat(cut.style) ? 'repeat-start' : 'normal', repeats: undefined,
    appearance: endsRepeat(cut.style) || index < bars.length && ['double', 'final'].includes(cut.style) ? undefined : cut.appearance,
    fermata: endsRepeat(cut.style) || index < bars.length && ['double', 'final'].includes(cut.style) ? undefined : cut.fermata,
    fermataAppearance: endsRepeat(cut.style) || index < bars.length && ['double', 'final'].includes(cut.style) ? undefined : cut.fermataAppearance }]);
  saveEditedBoundaries(score, entries);
  for (const notice of score.importNotices ?? []) if (notice.measure !== undefined && notice.measure >= index) notice.measure++;
  moveAnchors(score, bars, forward, forwardEnd, () => false, splitAnchors);
  return index;
}

function removeMeasureRun(score: Score, first: number, last: number) {
  const bars = measureTable(score);
  const left = bars[first].start, right = bars[last].end;
  const boundaries = Array.from({ length: bars.length + 1 }, (_, i) => boundaryAt(score, i));
  const removed = (at: number) => at >= left && at < right;
  const shift = (at: number) => at < left ? at : at < right ? left : tick(at - (right - left));
  const splitAnchors = new Map<string, SplitAnchor>();
  score.notes = score.notes.flatMap(note => {
    const end = tickEnd(note);
    if (end <= left || note.at >= right) { note.at = shift(note.at); return [note]; }
    if (note.at < left) { shorten(note, shift(end)); return [note]; }
    if (end <= right) return [];
    const tail = tailOf(note, right);
    respellTail(score, tail, note);
    keepBeamAnchors(note, tail, right, false);
    splitAnchors.set(note.id, { from: right, id: tail.id });
    tail.at = left;
    return [tail];
  });
  const prior = score.measures[first - 1];
  if (prior?.keepWithNext && (last + 1 === bars.length ||
    score.measures.slice(first, last + 1).some(bar => !bar.keepWithNext))) {
    delete prior.keepWithNext;
    prior.lockLineEnd = true;
  }
  score.measures.splice(first, last - first + 1);
  const next = bars[last + 1];
  if (next) {
    inheritBarContext(score, first, next);
    const survivor = score.measures[first];
    survivor.numberStep = bars[first].sequence - (bars[first - 1]?.sequence ?? 0);
    survivor.numberLabel = String(bars[first].number) === String(bars[first].sequence) ? undefined : String(bars[first].number);
  }
  const l = boundaries[first], r = boundaries[last + 1];
  const tail = first > 0 && endsRepeat(l.style);
  const head = !!next && startsRepeat(r.style);
  const style = tail && head ? 'repeat-both' : tail ? 'repeat-end' : head ? 'repeat-start' :
    next ? ['double', 'final'].includes(r.style) ? r.style : ['double', 'final'].includes(l.style) && first > 0 ? l.style : 'normal' : 'final';
  const entries: [number, Boundary][] = boundaries.flatMap((item, index) =>
    index < first ? [[index, item]] : index > last + 1 ? [[index - (last - first + 1), item]] : []);
  entries.push([first, { style, repeats: tail ? l.repeats : undefined, break: next ? r.break : undefined,
    appearance: (tail ? l : r).appearance, breakAppearance: next ? r.breakAppearance : undefined,
    fermata: l.fermata || r.fermata, fermataAppearance: r.fermata ? r.fermataAppearance : l.fermataAppearance }]);
  saveEditedBoundaries(score, entries);
  score.importNotices = score.importNotices?.flatMap(notice => notice.measure === undefined || notice.measure < first ? [notice]
    : notice.measure <= last ? [] : [{ ...notice, measure: notice.measure - (last - first + 1) }]);
  moveAnchors(score, bars, shift, shift, removed, splitAnchors);
}

export function deleteMeasures(score: Score, picked: Iterable<number>) {
  const indices = [...new Set(picked)].filter(i => Number.isInteger(i) && i >= 0 && i < score.measures.length).sort((a, b) => a - b);
  if (!indices.length) throw Error('请选择要删除的小节。');
  if (indices.length === score.measures.length) {
    const last = measureTable(score).at(-1)!;
    const blank = blankMeasure(last);
    blank.layout = structuredClone(last.layout);
    blank.localNames = structuredClone(last.localNames);
    blank.numberAppearance = structuredClone(last.numberAppearance);
    blank.numberStep = last.sequence;
    blank.numberLabel = String(last.number) === String(last.sequence) ? undefined : String(last.number);
    score.measures = [blank];
    score.notes = []; score.spans = [];
    delete score.boundaries; delete score.endings; delete score.columns;
    delete score.tempoMarks; delete score.tempoLines; delete score.tuplets;
    delete score.chordSymbols;
    score.importNotices = score.importNotices?.filter(notice => notice.measure === undefined);
    if (score.appearance) score.appearance = Object.fromEntries(Object.entries(score.appearance)
      .filter(([key]) => key.startsWith('["header",') || key.startsWith('["signature",0,')));
    removeLanes(score, new Set(score.lanes.filter(lane => lane.parent).map(lane => lane.id)));
    return 0;
  }
  for (let i = indices.length - 1; i >= 0;) {
    const last = indices[i];
    let first = last;
    while (i > 0 && indices[i - 1] === first - 1) first = indices[--i];
    removeMeasureRun(score, first, last);
    i--;
  }
  return Math.min(indices[0], score.measures.length - 1);
}

export function writeNote(score: Score, cursor: Cursor, pitches: Pitch[], value: number, dots: number, unpitched = false): number {
  const lane = score.lanes.find(item => item.id === cursor.lane)!;
  const group = tupletAt(score, cursor.lane, cursor.at);
  const source = noteAt(score, cursor);
  const same = group && source?.at === cursor.at && source.value === value && (source.dots ?? 0) === dots;
  const end = same ? tickEnd(source!) : rhythmicEnd(score, cursor, dotted(value, dots) * tupletScale(group), group);
  checkTupletEdit(score, cursor, end, group);
  if (lane.parent && (cursor.at < lane.start! || end > lane.end!))
    throw new Error('音符超出临时副线范围，请缩短时值或扩大副线。');
  while (measureTable(score).at(-1)!.end <= end && !lane.parent) addMeasure(score);
  cover(score, cursor.lane, cursor.at, end);
  const id = uid();
  const previousKey = JSON.stringify(['pitch', source?.id, cursor.at, 0]);
  const look = score.appearance?.[previousKey];
  if (look?.alignment !== undefined || look?.placement?.x !== undefined)
    (score.appearance ??= {})[JSON.stringify(['pitch', id, cursor.at, 0])] = { alignment: look.alignment, placement: look.placement };
  score.notes.push({ id, ...cursor, pitches: structuredClone(pitches), length: tick(end - cursor.at), value, dots,
    unpitched: unpitched || undefined });
  score.notes.sort((first, second) => first.at - second.at);
  pruneTies(score);
  return end;
}

function rhythmicEnd(score: Score, cursor: Cursor, length: number, group?: Tuplet) {
  const end = tick(cursor.at + length);
  if (!group) return end;
  const boundary = tickEnd(group);
  if (Math.abs(end - boundary) < 4e-8) return boundary;
  return score.notes.find(note => note.lane === cursor.lane && Math.abs(note.at - end) < 4e-8)?.at ?? end;
}

function checkTupletEdit(score: Score, cursor: Cursor, end: number, group?: Tuplet) {
  if (end <= cursor.at || group && end > tickEnd(group) ||
    (score.tuplets ?? []).some(other => other.lane === cursor.lane && other.at < end &&
      tickEnd(other) > cursor.at && other !== group && !(group && other.at <= group.at && tickEnd(other) >= tickEnd(group))))
    throw Error('时值不能越过多连音组边界。');
}

export function addSideLane(score: Score, anchor: string, start: number, end: number): Lane {
  const source = score.lanes.find(lane => lane.id === anchor);
  const main = source?.parent ? score.lanes.find(lane => lane.id === source.parent) : source;
  if (!source || !main) throw new Error('请选择要增加副线的声部。');
  start = Math.max(source.start ?? 0, start);
  end = Math.min(source.end ?? measureTable(score).at(-1)!.end, end);
  if (start >= end) throw new Error('请选择声部中的有效范围。');
  const voices = new Set([main.id, ...score.lanes.filter(lane => lane.parent === main.id).map(lane => lane.id)]);
  if (score.tuplets?.some(group => voices.has(group.lane) && [start, end].some(at => group.at < at && at < tickEnd(group))))
    throw Error('临时分部边界不能切进多连音组。');
  if (score.lanes.length >= 100) throw new Error('乐谱已达到 100 条声部线。');
  const siblings = score.lanes.filter(lane => lane.parent === main.id);
  const lane = { id: uid(), name: `${main.name}${siblings.length + 2}`, octave: source.octave, displayOctave: source.displayOctave, parent: main.id, start, end };
  score.lanes.splice(score.lanes.indexOf(source) + 1, 0, lane);
  return lane;
}

export function temporaryStack(score: Score, cursor: Cursor) {
  const source = score.lanes.find(lane => lane.id === cursor.lane);
  if (!source) return [];
  const main = source.parent ?? source.id;
  return score.lanes.filter(lane => lane.id === main || lane.parent === main && lane.start! <= cursor.at && cursor.at < lane.end!)
    .sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
}

function moveLaneInterval(score: Score, source: string, target: string, start: number, end: number) {
  for (const note of [...score.notes]) if (note.lane === source && note.at < end && tickEnd(note) > start) {
    const left = Math.max(start, note.at);
    const right = Math.min(end, tickEnd(note));
    const moved = isolateFragment(score, note, left, tick(right - left));
    moved.lane = target;
    if (moved !== note) {
      for (const span of score.spans) {
        if (span.from === note.id && span.fromAt !== undefined && span.fromAt >= left && span.fromAt < right) span.from = moved.id;
        if (span.to === note.id && span.toAt !== undefined && span.toAt > left && span.toAt <= right) span.to = moved.id;
      }
      for (const [key, value] of Object.entries(score.appearance ?? {})) {
        const parts = JSON.parse(key);
        if (parts[1] !== note.id || !['pitch', 'extension', 'generated-tie'].includes(parts[0]) || parts[2] < left || parts[2] >= right) continue;
        parts[1] = moved.id;
        delete score.appearance![key];
        score.appearance![JSON.stringify(parts)] = value;
      }
    }
  }
  for (const group of score.tuplets ?? []) if (group.lane === source && group.at >= start && tickEnd(group) <= end) group.lane = target;
  for (const symbol of score.chordSymbols ?? []) if (symbol.lane === source && symbol.at >= start && symbol.at < end) symbol.lane = target;
  for (const line of score.tempoLines ?? []) if (line.lane === source && line.from >= start && line.from < end) line.lane = target;
}

function splitSideAt(score: Score, lane: Lane, at: number, explicit = false) {
  if (!(lane.start! < at && at < lane.end!)) return;
  if (score.tuplets?.some(group => group.lane === lane.id && group.at < at && at < tickEnd(group)))
    throw Error('切分点不能落在多连音组内部。');
  if (score.lanes.length >= 100) throw Error('乐谱已达到 100 条声部线。');
  const right: Lane = { ...lane, id: uid(), start: at, splitStart: explicit || undefined };
  moveLaneInterval(score, lane.id, right.id, at, lane.end!);
  lane.end = at;
  score.lanes.splice(score.lanes.indexOf(lane) + 1, 0, right);
}

export function splitTemporaryVoices(score: Score, cursor: Cursor, at: number) {
  const sides = temporaryStack(score, cursor).slice(1);
  if (!sides.some(lane => lane.start! < at && at < lane.end!)) throw Error('切分点须在临时声部段内。');
  for (const lane of sides) splitSideAt(score, lane, at, true);
  pruneTies(score);
}

export function toggleTemporaryVoiceSplit(score: Score, cursor: Cursor, at: number) {
  const main = temporaryStack(score, cursor)[0]?.id;
  const explicit = score.lanes.filter(lane => lane.parent === main && lane.start === at && lane.splitStart);
  if (!explicit.length) { splitTemporaryVoices(score, cursor, at); return; }
  for (const lane of explicit) delete lane.splitStart;
  mergeTemporaryVoices(score, main!);
}

export function mergeTemporaryVoices(score: Score, main: string) {
  const sides = () => score.lanes.filter(lane => lane.parent === main);
  for (const boundary of [...new Set(sides().map(lane => lane.end!))].sort((a, b) => a - b)) {
    const left = sides().filter(lane => lane.end === boundary);
    const right = sides().filter(lane => lane.start === boundary);
    if (!left.length || left.length !== right.length || right.some(lane => lane.splitStart)) continue;
    if (left.some((lane, index) => lane.octave !== right[index].octave || lane.displayOctave !== right[index].displayOctave)) continue;
    for (let index = 0; index < left.length; index++) {
      const before = left[index], after = right[index];
      moveLaneInterval(score, after.id, before.id, after.start!, after.end!);
      before.end = after.end;
    }
    const removed = new Set(right);
    score.lanes = score.lanes.filter(lane => !removed.has(lane));
  }
}

export function deleteTemporaryVoiceInterval(score: Score, cursor: Cursor, end: number) {
  const stack = temporaryStack(score, cursor);
  if (stack.length < 2) throw Error('这里没有临时声部。');
  const [main, ...sides] = stack;
  const source = stack.findIndex(lane => lane.id === cursor.lane);
  const from = cursor.at;
  const to = Math.min(end, source ? stack[source].end! : Math.max(...sides.map(lane => lane.end!)));
  if (to <= from) return;
  const affected = new Set(stack.map(lane => lane.id));
  if (score.tuplets?.some(group => affected.has(group.lane) &&
      [from, to].some(at => group.at < at && at < tickEnd(group))))
    throw Error('删除范围不能切进多连音组。');
  const side = source === 0 ? sides[0] : stack[source];
  const limit = Math.min(to, side.end!);
  if (source === 0) {
    eraseInterval(score, main.id, from, to);
    moveLaneInterval(score, side.id, main.id, from, limit);
  } else eraseInterval(score, side.id, from, limit);
  if (score.tempoLines) score.tempoLines = score.tempoLines.filter(line => line.lane !== side.id || line.from < from || line.from >= limit);
  splitSideAt(score, side, limit);
  if (from <= side.start!) score.lanes = score.lanes.filter(lane => lane !== side);
  else side.end = from;
  if (source === 0 && limit < to) deleteTemporaryVoiceInterval(score, { lane: main.id, at: limit }, to);
  mergeTemporaryVoices(score, main.id);
  pruneTies(score);
}

export function swapTemporaryVoices(score: Score, cursor: Cursor, first: number, second: number) {
  const stack = temporaryStack(score, cursor);
  const a = stack[first - 1], b = stack[second - 1];
  if (!a || !b || a === b) throw Error('请选择当前临时分部中两个不同的声部编号。');
  if (a.parent && b.parent) {
    const i = score.lanes.indexOf(a), j = score.lanes.indexOf(b);
    [score.lanes[i], score.lanes[j]] = [b, a];
    return cursor;
  }
  const from = Math.max(a.start ?? 0, b.start ?? 0);
  const to = Math.min(a.end ?? Infinity, b.end ?? Infinity);
  const destinations = new Map([[a.id, b.id], [b.id, a.id]]);
  for (const group of score.tuplets ?? []) if (destinations.has(group.lane) && group.at < to && tickEnd(group) > from) {
    if (group.at < from || tickEnd(group) > to) throw Error('不能交换只覆盖部分多连音组的临时声部。');
    group.lane = destinations.get(group.lane)!;
  }
  for (const at of [from, to]) for (const note of [...score.notes]) {
    if (!destinations.has(note.lane) || note.at >= at || tickEnd(note) <= at) continue;
    const tail = splitNote(score, note, at);
    keepBeamAnchors(note, tail, at, true);
    for (const span of score.spans) {
      if (span.from === note.id && span.fromAt !== undefined && span.fromAt >= at) span.from = tail.id;
      if (span.to === note.id && span.toAt !== undefined && span.toAt > at) span.to = tail.id;
    }
    for (const [key, appearance] of Object.entries(score.appearance ?? {})) {
      const parts = JSON.parse(key);
      if (['pitch', 'extension', 'generated-tie'].includes(parts[0]) && parts[1] === note.id && parts[2] >= at) {
        parts[1] = tail.id;
        delete score.appearance![key];
        score.appearance![JSON.stringify(parts)] = appearance;
      }
    }
  }
  for (const note of score.notes) if (note.at >= from && note.at < to && destinations.has(note.lane)) note.lane = destinations.get(note.lane)!;
  for (const symbol of score.chordSymbols ?? []) if (symbol.at >= from && symbol.at < to && destinations.has(symbol.lane))
    symbol.lane = destinations.get(symbol.lane)!;
  const notes = new Map(score.notes.map(note => [note.id, note]));
  for (const span of score.spans) {
    const start = notes.get(span.from), end = notes.get(span.to);
    if (!start || !end || start.lane !== end.lane || !destinations.has(start.lane)) continue;
    const lane = stack.find(lane => lane.id === start.lane)!;
    if (span.fromAt !== undefined) span.fromAt = Math.max(lane.start ?? 0, span.fromAt);
    if (span.toAt !== undefined) span.toAt = Math.min(lane.end ?? Infinity, span.toAt);
  }
  if (score.appearance) score.appearance = Object.fromEntries(Object.entries(score.appearance).map(([key, value]) => {
    const parts = JSON.parse(key);
    const rest = typeof parts[1] === 'string' && /^rest:(.+):(\d+)$/.exec(parts[1]);
    if (parts[0] !== 'pitch' || !rest || !destinations.has(rest[1]) || +rest[2] < from || +rest[2] >= to) return [key, value];
    parts[1] = `rest:${destinations.get(rest[1])}:${rest[2]}`;
    return [JSON.stringify(parts), value];
  }));
  score.notes.sort((a, b) => a.at - b.at);
  pruneTies(score);
  return { lane: destinations.get(cursor.lane) ?? cursor.lane, at: cursor.at };
}

export function openScore(json: string): Score {
  const score: Score = JSON.parse(json);
  const valid = (condition: unknown) => {
    if (!condition) throw new Error('不是受支持的简谱工程，或工程内容不完整。');
  };
  const integer = (value: number, minimum: number, maximum: number) =>
    Number.isInteger(value) && value >= minimum && value <= maximum;
  const time = (value: number, minimum: number, maximum: number) =>
    Number.isFinite(value) && value >= minimum && value <= maximum;
  const text = (value: unknown) => typeof value === 'string' && value.length <= 300;
  const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1200;
  const textFace = (value: TextFace) => !!value && typeof value === 'object' &&
    (value.font === undefined || /^[\p{L}\p{N} ._-]{1,80}$/u.test(value.font)) &&
    (value.size === undefined || integer(value.size, 9, 48)) &&
    [value.bold, value.italic, value.underline, value.strike].every(item => item === undefined || typeof item === 'boolean') &&
    [undefined, 'start', 'middle', 'end'].includes(value.align);
  const textFormat = (format: TextFormat | undefined) => format === undefined || textFace(format) &&
    (format.runs === undefined || Array.isArray(format.runs) && format.runs.length <= 300 &&
      format.runs.every(run => run && integer(run.from, 0, 299) && integer(run.to, run.from + 1, 300) && textFace(run.face)));
  const appearance = (value: Appearance | undefined) => value === undefined || !!value && typeof value === 'object' &&
    [value.visible, value.layout, value.independentPosition, value.alignDynamics, value.playback].every(flag => flag === undefined || typeof flag === 'boolean') &&
    [undefined, 'left', 'right'].includes(value.noteSide) &&
    [undefined, 'full', 'half', 'none'].includes(value.alignment) &&
    [undefined, 'long', 'short'].includes(value.arcShape) &&
    (value.placement === undefined || !!value.placement && typeof value.placement === 'object' && !Array.isArray(value.placement) &&
      Object.entries(value.placement).every(([key, setting]) => key === 'edge' ? setting === 'from' || setting === 'to' :
        key === 'spaced' ? typeof setting === 'boolean' : ['x', 'y', 'from', 'to', 'fromY', 'toY', 'height'].includes(key) && coordinate(setting))) &&
    textFormat(value.text);
  const flow = (value: unknown) => [undefined, 'auto', 'each', 'first'].includes(value as LyricFlow | undefined);
  const validKey = (key?: KeySignature) => key === undefined || key && integer(key.fifths, -7, 7) && [1, 6].includes(key.degree);
  const validMeter = (meter?: Meter) => meter === undefined || meter && integer(meter.numerator, 1, 16) &&
    [2, 4, 8, 16].includes(meter.denominator) && Array.isArray(meter.groups) && meter.groups.every(group => integer(group, 1, 16)) &&
    meter.groups.reduce((sum, group) => sum + group, 0) === meter.numerator;
  valid(score?.version === 1 && text(score.title) && text(score.credit)
    && [score.subtitle, score.lyricist, score.arranger, score.composer, score.copyright].every(value => value === undefined || text(value))
    && integer(score.tonic, 0, 11) && integer(score.tempo, 20, 300) && validKey(score.key)
    && integer(score.numerator, 1, 16) && [2, 4, 8, 16].includes(score.denominator));
  valid(Array.isArray(score.groups) && score.groups.every(group => integer(group, 1, 16))
    && score.groups.reduce((sum, group) => sum + group, 0) === score.numerator);
  const validLineRule = (rule?: LineRule) => rule === undefined || rule && Number.isSafeInteger(rule.start) &&
    (rule.by !== 'position' || rule.start >= 1) && integer(rule.count, 1, 600) &&
    ['position', 'number'].includes(rule.by) && ['continue', 'restart'].includes(rule.overflow);
  valid(validLineRule(score.lineRule));
  valid(Array.isArray(score.measures) && score.measures.every(bar => bar?.lineSection === undefined || bar.lineSection &&
    text(bar.lineSection.id) && validLineRule({ ...bar.lineSection, start: 1 })));
  if (score.spacing !== undefined) valid(score.spacing && Object.entries(SPACING_LIMITS).every(([key, [min, max]]) => {
    const value = score.spacing![key as keyof Spacing];
    return value === undefined ? Object.hasOwn(marginAxis, key) : integer(value, min, max);
  }));
  const flag = (value: unknown) => value === undefined || typeof value === 'boolean';
  valid(score.titleSignatures === undefined || score.titleSignatures && flag(score.titleSignatures.key) && flag(score.titleSignatures.meter));
  const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  valid(flag(score.justifyBottom));
  valid(score.paper === undefined || record(score.paper) && time(score.paper.width, 80, 1200) && time(score.paper.height, 80, 1200));
  valid(score.folio === undefined || score.folio === false || record(score.folio) && integer(score.folio.start, 1, 9999) &&
    typeof score.folio.first === 'boolean' && ['top', 'bottom'].includes(score.folio.position) && ['center', 'outside'].includes(score.folio.align));
  valid(score.scalePercent === undefined || integer(score.scalePercent, ...SCORE_SCALE_RANGE));
  valid([undefined, 'auto', 'hide'].includes(score.measureNumbers));
  if (score.textStyles !== undefined) valid(record(score.textStyles) && Object.entries(score.textStyles).every(([key, style]) =>
    STYLE_ROLES.includes(key as StyleRole) && style && typeof style.font === 'string' && /^[\p{L}\p{N} ._-]{1,80}$/u.test(style.font) &&
    (style.cjkFont === undefined || typeof style.cjkFont === 'string' && /^[\p{L}\p{N} ._-]{1,80}$/u.test(style.cjkFont)) && flag(style.italic) && integer(style.size, 9, 48)));
  if (score.engravingStyle !== undefined) valid(record(score.engravingStyle) && Object.entries(score.engravingStyle).every(([key, value]) =>
    Object.hasOwn(ENGRAVING_STYLE, key) && Number.isFinite(value) &&
    value >= ENGRAVING_LIMITS[key as keyof EngravingStyle][0] && value <= ENGRAVING_LIMITS[key as keyof EngravingStyle][1]));
  if (score.pageLayouts !== undefined) valid(record(score.pageLayouts) &&
    Object.entries(score.pageLayouts).every(([page, settings]) => /^[1-9]\d*$/.test(page) && integer(Number(page), 1, 601) &&
      record(settings) && flag(settings.justifyBottom) && (settings.spacing === undefined || record(settings.spacing) &&
        Object.entries(settings.spacing).every(([key, value]) => {
          if (!Object.hasOwn(SPACING_LIMITS, key)) return false;
          const [min, max] = SPACING_LIMITS[key as keyof Spacing];
          return integer(value, min, max);
        }))));
  valid(Array.isArray(score.measures) && score.measures.length > 0 && score.measures.length <= 600
    && score.measures.every(measure => time(measure.length, 1e-8, 3072)
      && [undefined, 'line', 'page'].includes(measure.system)
      && (measure.number === undefined || text(measure.number))
      && (measure.numberLabel === undefined || text(measure.numberLabel))
      && (measure.numberStep === undefined || Number.isSafeInteger(measure.numberStep))
      && [undefined, 'auto', 'show', 'hide'].includes(measure.numberDisplay)
      && appearance(measure.numberAppearance) && appearance(measure.keyAppearance) && appearance(measure.meterAppearance)
      && (measure.highlights === undefined || record(measure.highlights) && Object.values(measure.highlights).every(highlight =>
        highlight && typeof highlight.color === 'string' && /^#[0-9a-f]{6}$/i.test(highlight.color) && integer(highlight.opacity, 0, 100)))
      && (measure.tonic === undefined || integer(measure.tonic, 0, 11))
      && (measure.repeatStart === undefined || typeof measure.repeatStart === 'boolean')
      && (measure.repeatEnd === undefined || integer(measure.repeatEnd, 2, 8))
      && validKey(measure.key) && validMeter(measure.meter) && validMeter(measure.actualMeter) && flag(measure.pickup) && flag(measure.meterHidden) && flag(measure.keyHidden)
      && (!measure.actualMeter || meterLength(measure.actualMeter) === measure.length)));
  const measures = measureTable(score);
  if (score.endings !== undefined) valid(Array.isArray(score.endings) && score.endings.length <= 600 &&
    score.endings.every(ending => integer(ending.start, 0, score.measures.length - 1) &&
      integer(ending.end, ending.start, score.measures.length - 1) && Array.isArray(ending.passes) &&
      ending.passes.length > 0 && ending.passes.every(pass => integer(pass, 1, 8)) && appearance(ending.appearance) &&
      (ending.fromAt === undefined || time(ending.fromAt, measures[ending.start].start, measures[ending.start].end) && ending.fromAt < measures[ending.start].end) &&
      (ending.toAt === undefined || integer(ending.toAt, measures[ending.end].start + 1, measures[ending.end].end)) &&
      endingRange(ending, measures).from < endingRange(ending, measures).to &&
      (ending.open === undefined || typeof ending.open === 'boolean')));
  const end = measures.at(-1)!.end;
  const rate = (value: number) => Number.isFinite(value) && value > 0 && value <= 1200;
  if (score.tempoMarks !== undefined) valid(Array.isArray(score.tempoMarks) && score.tempoMarks.length <= 5000 &&
    new Set(score.tempoMarks.map(mark => mark.id)).size === score.tempoMarks.length &&
    new Set(score.tempoMarks.map(mark => `${mark.at}:${mark.kind === 'swing' || mark.kind === 'straight'}`)).size === score.tempoMarks.length && score.tempoMarks.every(mark =>
      text(mark.id) && time(mark.at, 0, end) && mark.at < end && appearance(mark.appearance) && (mark.label === undefined || text(mark.label)) &&
      (mark.override === undefined || rate(mark.override)) && (mark.kind === 'restore' || mark.kind === 'primo' ||
        mark.kind === 'word' && rate(mark.bpm) ||
        (mark.kind === 'swing' || mark.kind === 'straight') && [24, 48].includes(mark.swingUnit) && time(mark.ratio, 1, 4) ||
        mark.kind === 'modulation' && TEMPO_UNITS.includes(mark.unit as typeof TEMPO_UNITS[number]) &&
          TEMPO_UNITS.includes(mark.rightUnit as typeof TEMPO_UNITS[number]) && integer(mark.dots, 0, 2) && integer(mark.rightDots, 0, 2) ||
        mark.kind === 'metronome' && TEMPO_UNITS.includes(mark.unit as typeof TEMPO_UNITS[number]) &&
        integer(mark.dots, 0, 2) && rate(mark.bpm) && (mark.writtenRate === undefined || text(mark.writtenRate)))));
  if (score.tempoLines !== undefined) valid(Array.isArray(score.tempoLines) && score.tempoLines.length <= 5000 &&
    new Set(score.tempoLines.map(line => line.id)).size === score.tempoLines.length && score.tempoLines.every(line =>
      text(line.id) && time(line.from, 0, end) && time(line.to, line.from, end) && line.to > line.from && TEMPO_LINE_KINDS.includes(line.kind) &&
      (line.label === undefined || text(line.label)) && (line.target === undefined || rate(line.target)) &&
      (line.percent === undefined || rate(line.percent)) && flag(line.dashVisible) && flag(line.dashLayout) && flag(line.playback) &&
      (line.lane === undefined || typeof line.lane === 'string') && appearance(line.appearance)));
  if (score.columns !== undefined) valid(record(score.columns) && Object.entries(score.columns).every(([at, x]) =>
    /^\d+(?:\.\d+)?$/.test(at) && time(Number(at), 0, end) && coordinate(x)));
  if (score.appearance !== undefined) valid(score.appearance && typeof score.appearance === 'object' &&
    !Array.isArray(score.appearance) && Object.entries(score.appearance).every(([key, value]) => key.startsWith('[') && appearance(value)));
  if (score.boundaries !== undefined) valid(score.boundaries && typeof score.boundaries === 'object' && !Array.isArray(score.boundaries) &&
    Object.entries(score.boundaries).every(([index, boundary]) => /^\d+$/.test(index) && integer(Number(index), 0, score.measures.length) &&
      boundary && (boundary.style === undefined || BAR_STYLES.includes(boundary.style) &&
        (Number(index) > 0 || !endsRepeat(boundary.style)) &&
        (Number(index) < score.measures.length || !startsRepeat(boundary.style))) &&
      (boundary.repeats === undefined || integer(boundary.repeats, 0, 7)) &&
      [undefined, 'line', 'page'].includes(boundary.break) && flag(boundary.fermata) && appearance(boundary.appearance) &&
      appearance(boundary.breakAppearance) && appearance(boundary.fermataAppearance)));
  valid(Array.isArray(score.lanes) && score.lanes.length > 0 && score.lanes.length <= 100
    && score.lanes.every(lane => text(lane.id) && text(lane.name) && integer(lane.octave, 1, 7) && flag(lane.splitStart) && flag(lane.fullNoteVolume) &&
      (lane.shortName === undefined || text(lane.shortName)) && (lane.displayOctave === undefined || integer(lane.displayOctave, 1, 7))
      && [undefined, 'show', 'hide', 'rest'].includes(lane.display) && textFormat(lane.nameText) && textFormat(lane.shortNameText) &&
      (lane.sharedNamePlacement === undefined || appearance({ placement: lane.sharedNamePlacement }))));
  const lanes = new Map(score.lanes.map(lane => [lane.id, lane]));
  valid(lanes.size === score.lanes.length && score.lanes.some(lane => lane.parent === undefined));
  if (score.chordSymbols !== undefined) valid(Array.isArray(score.chordSymbols) && score.chordSymbols.length <= 5000 &&
    new Set(score.chordSymbols.map(symbol => symbol.id)).size === score.chordSymbols.length &&
    score.chordSymbols.every(symbol => text(symbol.id) && text(symbol.text) &&
      (symbol.actual === undefined || text(symbol.actual) && parseChord(symbol.actual)) &&
      time(symbol.at, 0, end) && symbol.at < end && lanes.has(symbol.lane) &&
      (!lanes.get(symbol.lane)?.parent || lanes.get(symbol.lane)!.start! <= symbol.at && symbol.at < lanes.get(symbol.lane)!.end!)));
  const routeIds = new Set<string>();
  valid(score.measures.every(bar => flag(bar.keepWithNext) && flag(bar.lockLineEnd) && (bar.route === undefined ||
    Array.isArray(bar.route) && bar.route.length <= 30 && bar.route.every(mark => {
      if (!mark || !text(mark.id) || routeIds.has(mark.id)) return false;
      routeIds.add(mark.id);
      return ROUTE_KINDS.includes(mark.kind) && typeof mark.target === 'string' && mark.target.length > 0 &&
        mark.target.length <= 40 && [undefined, 'fine', 'coda'].includes(mark.until) && flag(mark.repeat);
    }))));
  const main = (id: string) => lanes.has(id) && !lanes.get(id)?.parent;
  const parts = new Set<string>();
  if (score.linkedParts !== undefined) valid(Array.isArray(score.linkedParts) && score.linkedParts.length <= 100 &&
    score.linkedParts.every(part => {
      if (!part || !text(part.id) || parts.has(part.id) || typeof part.name !== 'string' || !part.name.trim() || part.name.length > 80 ||
        !Array.isArray(part.lanes) || !part.lanes.length || !part.lanes.every(main) ||
        ![part.showNames, part.showLyrics, part.showDynamics, part.copyBreaks].every(flag) ||
        part.presentation !== undefined && (!record(part.presentation) || part.presentation.version !== 1) ||
        !validLineRule(part.lineRule) || part.scalePercent !== undefined && !integer(part.scalePercent, ...SCORE_SCALE_RANGE)) return false;
      parts.add(part.id);
      return true;
    }));
  valid(score.measures.every(bar => bar.partBreaks === undefined || record(bar.partBreaks) &&
    Object.entries(bar.partBreaks).every(([id, value]) => parts.has(id) && (value === 'line' || value === 'page'))));
  const validBracket = (item: StaffBracket) => item && text(item.id) && BRACKET_TYPES.includes(item.type) &&
    main(item.top) && main(item.bottom) && appearance(item.appearance);
  valid(score.brackets === undefined || Array.isArray(score.brackets) && score.brackets.every(validBracket) &&
    new Set(score.brackets.map(item => item.id)).size === score.brackets.length);
  valid(score.measures.every(bar =>
    (bar.localNames === undefined || record(bar.localNames) && Object.entries(bar.localNames).every(([id, name]) =>
      main(id) && name && text(name.content) && textFormat(name.text))) &&
    (bar.layout === undefined || record(bar.layout) &&
      (bar.layout.visibility === undefined || record(bar.layout.visibility) &&
        Object.entries(bar.layout.visibility).every(([id, choice]) => lanes.has(id) && (choice === 'show' || choice === 'hide'))) &&
      (bar.layout.brackets === undefined || record(bar.layout.brackets) && Object.entries(bar.layout.brackets).every(([id, bracket]) =>
        bracket === null ? text(id) : validBracket(bracket) && bracket.id === id)))));
  valid(score.measures.every(measure => Object.keys(measure.highlights ?? {}).every(lane => lanes.has(lane))));
  if (score.importNotices !== undefined) valid(Array.isArray(score.importNotices) && score.importNotices.length <= 5000 &&
    score.importNotices.every(notice => text(notice.text) &&
      (notice.measure === undefined || integer(notice.measure, 0, score.measures.length - 1)) &&
      (notice.offset === undefined || notice.measure !== undefined && time(notice.offset, 0, end)) &&
      (notice.lane === undefined || lanes.has(notice.lane))));
  for (const lane of score.lanes) if (lane.parent !== undefined) {
    valid(lanes.has(lane.parent) && !lanes.get(lane.parent)!.parent
      && time(lane.start!, 0, end) && time(lane.end!, lane.start!, end) && lane.start! < lane.end!);
  }
  valid(Array.isArray(score.notes) && score.notes.length <= 30000);
  const notes = new Map<string, Note>();
  const laneEnds = new Map<string, number>();
  if (score.tuplets !== undefined) {
    valid(Array.isArray(score.tuplets) && score.tuplets.length <= 30000);
    const groups = new Map(score.tuplets.map(group => [group.id, group]));
    const stacks = new Map<string, Tuplet[]>();
    const bars = measureTable(score);
    valid(groups.size === score.tuplets.length);
    for (const group of [...score.tuplets].sort((a, b) => a.at - b.at || b.length - a.length || Number(!!a.parent) - Number(!!b.parent))) {
      const lane = lanes.get(group.lane);
      const parent = groups.get(group.parent ?? '');
      valid(lane && text(group.id) && time(group.at, lane?.start ?? 0, end) && time(tickEnd(group), group.at, lane?.end ?? end) &&
        group.length > 0 && integer(group.count, 2, 999) && VALUES.some(value => value === group.unit) &&
        (group.ratio === undefined || Array.isArray(group.ratio) && group.ratio.length === 2 &&
          group.ratio.every(value => Number.isSafeInteger(value) && value > 0) &&
          Math.abs(tupletWritten(group) * tupletScale(group) - group.length) < 1e-7) &&
        (group.written === undefined || time(group.written, 1e-8, 100000)) &&
        bars.some(bar => bar.start <= group.at && tickEnd(group) <= bar.end) &&
        (group.parent === undefined || parent && parent.lane === group.lane && parent.at <= group.at && tickEnd(parent) >= tickEnd(group)));
      const stack = stacks.get(group.lane) ?? [];
      while (stack.length && tickEnd(stack.at(-1)!) <= group.at) stack.pop();
      valid((stack.at(-1)?.id) === group.parent);
      stack.push(group);
      stacks.set(group.lane, stack);
    }
  }
  for (const note of [...score.notes].sort((first, second) => first.at - second.at)) {
    const lane = lanes.get(note.lane);
    valid(lane && text(note.id) && !notes.has(note.id) && time(note.at, lane?.start ?? 0, end) && note.at < end
      && time(tickEnd(note), note.at, lane?.end ?? end) && note.length > 0 && note.at >= (laneEnds.get(note.lane) ?? 0)
      && Array.isArray(note.pitches) && note.pitches.length <= 8
      && (note.unpitched === undefined || note.unpitched === true)
      && (note.unpitchedContinuation === undefined || note.unpitchedContinuation === true && note.unpitched === true)
      && (note.ornaments === undefined || record(note.ornaments) && Object.entries(note.ornaments).every(([kind, item]) =>
        ORNAMENT_KINDS.includes(kind as OrnamentKind) && record(item) &&
        (item.upper === undefined || integer(item.upper, -2, 2)) && (item.lower === undefined || integer(item.lower, -2, 2)) &&
        (item.strokes === undefined || integer(item.strokes, 1, 3)) && [item.fromUpper, item.delayed, item.wave].every(flag)))
      && note.pitches.every(pitch => integer(pitch.degree, 1, 7) && integer(pitch.octave, 0, 8)
        && integer(pitch.alter, -2, 2) && flag(pitch.natural) && flag(pitch.courtesy) && [undefined, 'show', 'hide'].includes(pitch.signStyle))
      && (note.value === undefined || [...VALUES, 6, 3].some(value => value === note.value))
      && (note.dots === undefined || integer(note.dots, 0, 2))
      && (note.grace === undefined || record(note.grace) && (note.pitches.length > 0 || note.unpitched) && Object.entries(note.grace).every(([side, group]) =>
        GRACE_SIDES.some(item => item === side) && record(group) && Array.isArray(group.notes) && group.notes.length > 0 && group.notes.length <= 64 &&
        new Set(group.notes.map(item => item.id)).size === group.notes.length &&
        (group.borrow === undefined || time(group.borrow, 0, 100)) &&
        (group.layout === undefined || record(group.layout) &&
          (group.layout.y === undefined || time(group.layout.y, -160, 160)) &&
          (group.layout.x === undefined || record(group.layout.x) && Object.values(group.layout.x).every(value => time(value, -160, 160)))) &&
        (group.links === undefined || Array.isArray(group.links) && group.links.length <= 512 && group.links.every(link => {
          const from = group.notes.findIndex(event => event.id === link.from), to = group.notes.findIndex(event => event.id === link.to);
          return text(link.id) && from >= 0 && to > from && integer(link.fromPitch, 0, group.notes[from].pitches.length - 1) &&
            integer(link.toPitch, 0, group.notes[to].pitches.length - 1) && (link.kind === 'slur' || link.kind === 'tie' && to === from + 1);
        })) &&
        group.notes.every(item => text(item.id) && VALUES.some(value => value === item.value) &&
          (item.beam === undefined || BEAM_MODES.includes(item.beam)) &&
          [item.staccato, item.accent, item.tenuto, item.fermata].every(flag) &&
          [undefined, 'upbow', 'comma', 'tick', 'salzedo'].includes(item.breath) &&
          (item.dots === undefined || integer(item.dots, 0, 2)) && Array.isArray(item.pitches) && item.pitches.length > 0 && item.pitches.length <= 8 &&
          item.pitches.every(pitch => integer(pitch.degree, 1, 7) && integer(pitch.octave, 0, 8) &&
            integer(pitch.alter, -2, 2) && flag(pitch.natural) && flag(pitch.courtesy) && [undefined, 'show', 'hide'].includes(pitch.signStyle)))))
      && [note.lyric, note.dynamic, note.text, note.interNoteText, note.rehearsal].every(value => value === undefined || text(value))
      && (note.extensionText === undefined || record(note.extensionText) && Object.entries(note.extensionText).every(([offset, row]) =>
        time(Number(offset), 0, note.length) && Number(offset) > 0 && Number(offset) < note.length && record(row) && Object.entries(row).every(([key, value]) => isExtensionText(key) && text(value))))
      && (note.verses === undefined || Array.isArray(note.verses) && note.verses.length <= 20 &&
        new Set(note.verses.map(verse => verse.number)).size === note.verses.length &&
        note.verses.every(verse => integer(verse.number, 1, 20) && (verse.text === undefined || text(verse.text)) &&
          [undefined, 'start', 'continue', 'stop'].includes(verse.extend) && flag(verse.syllabicNext)))
      && [undefined, 'break', 'join'].includes(note.beam)
      && (note.beams === undefined || note.beams && typeof note.beams === 'object' && !Array.isArray(note.beams) &&
        Object.entries(note.beams).every(([at, mode]) => /^\d+(?:\.\d+)?$/.test(at) && BEAM_MODES.includes(mode)))
      && (note.xmlBeams === undefined || note.xmlBeams && typeof note.xmlBeams === 'object' && !Array.isArray(note.xmlBeams) &&
        Object.entries(note.xmlBeams).every(([at, mask]) => /^\d+(?:\.\d+)?$/.test(at) && integer(mask, 0, 255)))
      && flow(note.lyricFlow)
      && [note.accent, note.staccato, note.fermata, note.split, note.tenuto].every(value => value === undefined || typeof value === 'boolean')
      && [undefined, true, false, 'upbow', 'comma', 'tick', 'salzedo'].includes(note.breath));
    notes.set(note.id, note);
    laneEnds.set(note.lane, tickEnd(note));
  }
  valid(Array.isArray(score.spans) && score.spans.length <= 30000);
  for (const span of score.spans) {
    const from = notes.get(span.from);
    const to = notes.get(span.to);
    const wedge = span.kind === 'crescendo' || span.kind === 'diminuendo';
    valid((span.dynamicText === undefined || wedge && text(span.dynamicText)) &&
      (span.dynamicTarget === undefined || wedge && DYNAMIC_STEPS.includes(span.dynamicTarget)));
    const lane = from && lanes.get(from.lane);
    valid(from && to && from.lane === to.lane && (span.fromAt ?? from.at) < (span.toAt ?? to.at)
      && (span.fromAt === undefined || wedge && time(span.fromAt, lane?.start ?? 0, lane?.end ?? end))
      && (span.toAt === undefined || wedge && time(span.toAt, lane?.start ?? 0, lane?.end ?? end))
      && flow(span.lyricFlow) && appearance(span.appearance)
      && ['tie', 'slur', 'crescendo', 'diminuendo', 'slide', 'tremolo'].includes(span.kind) &&
      (span.strokes === undefined || integer(span.strokes, 1, 3)));
    if (span.kind === 'tie') valid(tickEnd(from!) === to!.at
      && integer(span.pitch!, 0, from!.pitches.length - 1)
      && integer(span.targetPitch!, 0, to!.pitches.length - 1)
      && sound(from!.pitches[span.pitch!], tonicAt(score, from!.at)) === sound(to!.pitches[span.targetPitch!], tonicAt(score, to!.at)));
    if (span.kind === 'slur' || span.kind === 'slide') valid(from!.pitches.length && to!.pitches.length);
    if (span.kind === 'tremolo') valid(tickEnd(from!) === to!.at && from!.length === to!.length &&
      from!.pitches.length === 1 && to!.pitches.length === 1);
  }
  return score;
}
