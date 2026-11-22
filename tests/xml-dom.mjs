// Minimal XML DOM sufficient for src/musicxml.ts. Strict on well-formedness.
class Node {
  constructor(localName, parent) {
    this.localName = localName;
    this.parentNode = parent;
    this.childNodes = [];
    this.attributes = new Map();
  }
  get children() { return this.childNodes.filter(n => n instanceof Element); }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }
  getElementById() { return null; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  get textContent() {
    if (this instanceof Text) return this.data;
    return this.childNodes.map(n => n.textContent).join('');
  }
}
class Element extends Node {}
class Text extends Node {
  constructor(data, parent) { super('#text', parent); this.data = data; }
}
class Document extends Node {
  constructor() { super('#document', null); }
  get documentElement() { return this.children[0] ?? null; }
  getElementsByTagName(name) {
    const out = [];
    const walk = node => { for (const child of node.childNodes) {
      if (child instanceof Element) {
        if (name === '*' || child.localName === name || child.fullName === name) out.push(child);
        walk(child);
      }
    } };
    walk(this);
    return out;
  }
}
const PREDEFINED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text, where) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff) throw new Error('bad character ref ' + match + ' in ' + where);
      return String.fromCodePoint(code);
    }
    if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body];
    throw new Error('unknown entity ' + match + ' in ' + where);
  });
}
class Parser {
  constructor(source) { this.s = source.replace(/\r\n?/g, '\n'); this.i = 0; this.doc = new Document(); this.stack = [this.doc]; }
  top() { return this.stack[this.stack.length - 1]; }
  error(message) { throw new Error(message + ' at ' + this.i); }
  parse() {
    const s = this.s;
    while (this.i < s.length) {
      const lt = s.indexOf('<', this.i);
      if (lt < 0) { this.addText(s.slice(this.i)); this.i = s.length; break; }
      if (lt > this.i) this.addText(s.slice(this.i, lt));
      if (s.startsWith('<!--', lt)) {
        const end = s.indexOf('-->', lt + 4);
        if (end < 0) this.error('unterminated comment');
        this.i = end + 3;
      } else if (s.startsWith('<![CDATA[', lt)) {
        const end = s.indexOf(']]>', lt + 9);
        if (end < 0) this.error('unterminated CDATA');
        this.addText(s.slice(lt + 9, end), true);
        this.i = end + 3;
      } else if (s.startsWith('<?', lt)) {
        const end = s.indexOf('?>', lt + 2);
        if (end < 0) this.error('unterminated PI');
        this.i = end + 2;
      } else if (s.startsWith('<!DOCTYPE', lt)) {
        let depth = 0, j = lt + 9, quote = null;
        for (; j < s.length; j++) {
          const ch = s[j];
          if (quote) { if (ch === quote) quote = null; }
          else if (ch === '"' || ch === "'") quote = ch;
          else if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (ch === '>' && depth <= 0) break;
        }
        if (j >= s.length) this.error('unterminated doctype');
        this.i = j + 1;
      } else if (s.startsWith('</', lt)) {
        const end = s.indexOf('>', lt + 2);
        if (end < 0) this.error('unterminated close tag');
        const name = s.slice(lt + 2, end).trim();
        const top = this.top();
        if (!(top instanceof Element) || (top.fullName !== name && top.localName !== name)) this.error('mismatched </' + name + '> for <' + (top.fullName ?? top.localName) + '>');
        this.stack.pop();
        this.i = end + 1;
      } else {
        this.parseOpenTag(lt);
      }
    }
    if (this.stack.length !== 1) this.error('unclosed <' + this.top().localName + '>');
    if (!this.doc.documentElement) this.error('no root element');
    return this.doc;
  }
  addText(raw, cdata = false) {
    const text = cdata ? raw : decodeEntities(raw, 'text');
    const parent = this.top();
    // merge adjacent text nodes
    const last = parent.childNodes[parent.childNodes.length - 1];
    if (last instanceof Text && !cdata) last.data += text;
    else parent.childNodes.push(new Text(text, parent));
  }
  parseOpenTag(lt) {
    const s = this.s;
    let i = lt + 1;
    const nameMatch = /^[^\s/>]+/.exec(s.slice(i));
    if (!nameMatch) this.error('bad open tag');
    const fullName = nameMatch[0];
    if (fullName.includes('!')) this.error('unsupported markup ' + fullName);
    i += fullName.length;
    const element = new Element(fullName.slice(fullName.indexOf(':') + 1), this.top());
    element.fullName = fullName;
    let selfClosing = false;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '>') { i++; break; }
      if (s[i] === '/' && s[i + 1] === '>') { selfClosing = true; i += 2; break; }
      const attrMatch = /^([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(s.slice(i));
      if (!attrMatch) this.error('bad attribute near ' + s.slice(i, i + 30));
      const value = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
      element.attributes.set(attrMatch[1], decodeEntities(value, 'attribute'));
      i += attrMatch[0].length;
    }
    this.top().childNodes.push(element);
    if (!selfClosing) this.stack.push(element);
    this.i = i;
  }
}
export class DOMParser {
  parseFromString(source) {
    const doc = new Document();
    try {
      const parsed = new Parser(source).parse();
      return parsed;
    } catch (error) {
      const root = new Element('parsererror', doc);
      root.childNodes.push(new Text(String(error?.message ?? error), root));
      doc.childNodes.push(root);
      return doc;
    }
  }
}
export function installDOM() { globalThis.DOMParser = DOMParser; }
export function fileLike(name, bytes) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return { name, size: data.length, text: async () => new TextDecoder().decode(data), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}
