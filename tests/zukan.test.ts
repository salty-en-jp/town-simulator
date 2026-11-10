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
煙をはいて走る。

二つめの段落。
三つめの段落。
## heavy ゴウリキ形
## coach 客車
客を運ぶ。
`;
    const f = parseFlavor(md);
    expect(f.steam).toEqual(['煙をはいて走る。', '二つめの段落。', '三つめの段落。']);
    expect(f.heavy).toBeUndefined();
    expect(f.coach).toEqual(['客を運ぶ。']);
    expect(Object.keys(f)).not.toContain('書き方');
  });

  it('src/data/zukan.md に、全部の車両の見出しがある', () => {
    const md = zukanMd;
    for (const t of [...ENGINE_TYPES, ...WAGON_TYPES]) expect(md).toMatch(new RegExp(`^## ${t}( |$)`, 'm'));
  });
});

describe('自社開発と部品の説明文', () => {
  it('dev-… と part-… の見出しも読む。何行かある一言は、番号でいつも同じ1行を選ぶ', async () => {
    const { pickLine } = await import('../src/ui/flavor');
    const f = parseFlavor(`## dev-electric-commuter 電気・通勤
朝の町を走る。
## dev-star5 ★5
{name}は名機と呼ばれた。
{name}の名は長く残った。
## part-boiler 高圧ボイラー
圧を上げる。
## nope-thing
無視される。`);
    expect(f['dev-electric-commuter']).toEqual(['朝の町を走る。']);
    expect(f['dev-star5']).toHaveLength(2);
    expect(f['part-boiler']).toEqual(['圧を上げる。']);
    expect(f['nope-thing']).toBeUndefined();
    expect(pickLine(f['dev-star5'], 7)).toBe(pickLine(f['dev-star5'], 7));
    expect(pickLine(f['dev-star5'], 0)).not.toBe(pickLine(f['dev-star5'], 1));
    expect(pickLine(undefined, 3)).toBeUndefined();
  });

  it('src/data/zukan.md に、動力×用途・評価・部品の見出しがある', async () => {
    const { DEV_POWERS, DEV_USES } = await import('../src/sim/constants');
    const { PARTS } = await import('../src/sim/tech');
    for (const p of DEV_POWERS) for (const u of DEV_USES) expect(zukanMd).toMatch(new RegExp(`^## dev-${p}-${u}( |$)`, 'm'));
    for (const k of ['dev-star1', 'dev-star2', 'dev-star3', 'dev-star4', 'dev-star5', 'dev-defect', 'dev-award']) expect(zukanMd).toMatch(new RegExp(`^## ${k}( |$)`, 'm'));
    for (const p of PARTS) expect(zukanMd).toMatch(new RegExp(`^## part-${p.id}( |$)`, 'm'));
  });
});

describe('イカズチ形電気機関車', () => {
  it('1978年に登場し、電化した線路だけを走る', async () => {
    const { createEmptyWorld, canBuy, needsWire } = await import('../src/sim/world');
    const w = createEmptyWorld(20, 20, 1);
    expect(canBuy(w, 'electric')).toBe(false);
    w.day = Math.round((Date.UTC(1978, 0, 1) - Date.UTC(1960, 0, 1)) / 86_400_000);
    expect(canBuy(w, 'electric')).toBe(true);
    expect(needsWire({ cars: [{ type: 'electric' }] } as never)).toBe(true);
  });
});
