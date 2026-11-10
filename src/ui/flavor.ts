// 図鑑の説明文（src/data/zukan.md）を読む。描画とは切り離してある（テストできるように）

import { ENGINE_TYPES, WAGON_TYPES } from '../sim/constants';

/** zukan.md を読む：「## 英字 …」の見出しごとに、段落の配列 */
export function parseFlavor(md: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const all = new Set<string>([...ENGINE_TYPES, ...WAGON_TYPES]);
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur && all.has(cur)) {
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

