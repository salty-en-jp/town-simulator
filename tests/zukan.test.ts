import { describe, expect, it } from 'vitest';
import { ENGINE_TYPES, WAGON_TYPES } from '../src/sim/constants';
import { parseFlavor } from '../src/ui/flavor';
import zukanMd from '../src/data/zukan.md?raw';

describe('図鑑の説明文', () => {
  it('見出しの英字ごとに段落を読む。車両でない見出しと空の見出しは無視', () => {
    const md = `# タイトル
説明（無視）
## 書き方
- これも無視
## steam ツナグ形蒸気機関車
煙をはいて
走る。

二つめの段落。
## heavy ゴウリキ形
## coach 客車
客を運ぶ。
`;
    const f = parseFlavor(md);
    expect(f.steam).toEqual(['煙をはいて走る。', '二つめの段落。']);
    expect(f.heavy).toBeUndefined();
    expect(f.coach).toEqual(['客を運ぶ。']);
    expect(Object.keys(f)).not.toContain('書き方');
  });

  it('src/data/zukan.md に、全部の車両の見出しがある', () => {
    const md = zukanMd;
    for (const t of [...ENGINE_TYPES, ...WAGON_TYPES]) expect(md).toMatch(new RegExp(`^## ${t}( |$)`, 'm'));
  });
});
