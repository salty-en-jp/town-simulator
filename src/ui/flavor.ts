// 図鑑の説明文（src/data/zukan.md）を読む。描画とは切り離してある（テストできるように）

import { ENGINE_TYPES, WAGON_TYPES } from '../sim/constants';

/** zukan.md を読む：「## 英字 …」の見出しごとに、段落の配列 */
export function parseFlavor(md: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const all = new Set<string>([...ENGINE_TYPES, ...WAGON_TYPES]);
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    // 車両の英字と、自社開発（dev-…）・部品（part-…）の見出しを読む
    if (cur && (all.has(cur) || /^(dev|part|names)-[a-z0-9-]+$/.test(cur))) {
      // 改行したところで段落を分ける（空行はあってもなくてもよい）
      const paras = buf.map((l) => l.trim()).filter(Boolean);
      if (paras.length) out[cur] = paras;
    }
    buf = [];
  };
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(\S+)/);
    if (m) {
      flush();
      cur = m[1];
      continue;
    }
    if (line.startsWith('# ')) continue;
    if (cur) buf.push(line);
  }
  flush();
  return out;
}


/** 何行か書いてある中から、番号で1行を選ぶ（同じ番号ならいつも同じ行） */
export function pickLine(lines: string[] | undefined, n: number): string | undefined {
  if (!lines?.length) return undefined;
  return lines[Math.abs(Math.floor(n)) % lines.length];
}

/** 見出しの日本語（「## steam ツナグ形蒸気機関車」の「ツナグ形蒸気機関車」）を、車両の名前として読む */
export function parseNames(md: string): Record<string, string> {
  const all = new Set<string>([...ENGINE_TYPES, ...WAGON_TYPES]);
  const out: Record<string, string> = {};
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(\S+)\s+(.+?)\s*$/);
    if (m && all.has(m[1])) out[m[1]] = m[2].slice(0, 20);
  }
  return out;
}
