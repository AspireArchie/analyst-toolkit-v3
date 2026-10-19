export type DataOperation = 'defang' | 'refang' | 'base64-encode' | 'base64-decode' | 'json';
export type DataEncoding = 'utf8' | 'utf16le';
const maxInput = 2 * 1024 * 1024;

export function refang(value: string): string {
  return value.replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\uff0e\u3002\uff61]/g, '.')
    .replace(/\[[ \t]*(?:\.|dot)[ \t]*\]|\([ \t]*(?:\.|dot)[ \t]*\)|\{[ \t]*(?:\.|dot)[ \t]*\}|\\\./gi, '.')
    .replace(/\[[ \t]*(?::|colon)[ \t]*\]|\([ \t]*(?::|colon)[ \t]*\)|\{[ \t]*(?::|colon)[ \t]*\}/gi, ':')
    .replace(/[ \t]+dot[ \t]+/gi, '.')
    .replace(/[ \t]*([.:])[ \t]*/g, '$1')
    .replace(/\bhxxp(s?)(?=:\/\/)/gi, (_match, secure: string) => `http${secure.toLowerCase()}`);
}

export function defang(value: string): string {
  return refang(value).replace(/\bhttp(s?)(?=:\/\/)/gi, (_match, secure: string) => `hxxp${secure.toLowerCase()}`)
    .replace(/\./g, '[.]').replace(/:/g, '[:]');
}

function encodeBase64(value: string, encoding: DataEncoding): string {
  let bytes: Uint8Array;
  if (encoding === 'utf16le') {
    bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) { bytes[i * 2] = value.charCodeAt(i) & 255; bytes[i * 2 + 1] = value.charCodeAt(i) >> 8; }
  } else bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}

function decodeBase64(value: string, encoding: DataEncoding): string {
  let normalized = value.replace(/[\t\n\f\r ]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 || (normalized.includes('=') && normalized.length % 4 !== 0)) throw Error('Invalid Base64. Check characters, length and padding.');
  normalized += '='.repeat((4 - normalized.length % 4) % 4);
  const raw = atob(normalized), bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  try { return new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error(`Decoded bytes are not valid ${encoding === 'utf16le' ? 'UTF-16LE' : 'UTF-8'} text. Check the text encoding.`); }
}

export function beautifyJson(value: string, indent: string): string {
  try { JSON.parse(value); } catch (error) { throw Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  // Format the original tokens instead of serializing parsed numbers. This keeps
  // large integers, duplicate keys and string/number lexemes intact in evidence.
  const compact = value.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
  const output: string[] = []; let depth = 0, inString = false, escaped = false, length = 0;
  const append = (text: string) => { length += text.length; if (length > 8 * 1024 * 1024) throw Error('Formatted JSON exceeds 8 MB. Use a smaller input.'); output.push(text); };
  for (let i = 0; i < compact.length; i++) {
    const character = compact[i];
    if (inString) { append(character); if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') inString = false; continue; }
    if (character === '"') { inString = true; append(character); }
    else if (character === '{' || character === '[') {
      if (++depth > 100) throw Error('JSON nesting exceeds 100 levels. Use a shallower document.');
      append(character); if (compact[i + 1] !== '}' && compact[i + 1] !== ']') append('\n' + indent.repeat(depth));
    } else if (character === '}' || character === ']') {
      depth--; if (compact[i - 1] !== '{' && compact[i - 1] !== '[') append('\n' + indent.repeat(depth)); append(character);
    } else if (character === ',') append(',\n' + indent.repeat(depth));
    else if (character === ':') append(': ');
    else append(character);
  }
  return output.join('');
}

export function transformData(operation: DataOperation, value: string, encoding: DataEncoding = 'utf8', indentation = '2'): string {
  if (value.length > maxInput) throw Error('Input exceeds 2 MB of text. Split it into smaller sections.');
  if (encoding !== 'utf8' && encoding !== 'utf16le') throw Error('Unsupported text encoding.');
  switch (operation) {
    case 'defang': return defang(value);
    case 'refang': return refang(value);
    case 'base64-encode': return encodeBase64(value, encoding);
    case 'base64-decode': return decodeBase64(value, encoding);
    case 'json':
      if (!['2', '4', 'tab'].includes(indentation)) throw Error('Unsupported JSON indentation.');
      return beautifyJson(value, indentation === 'tab' ? '\t' : ' '.repeat(Number(indentation)));
    default: throw Error('Unsupported data operation.');
  }
}
