import { describe, expect, it } from 'vitest';
import { compareVersion, RELEASE_NOTES, releaseNotesHtml } from '../src/ui/manual';
import { VERSION } from '../src/version';

describe('リリースノート', () => {
  it('版の比べっこ', () => {
    expect(compareVersion('0.5.10', '0.5.9')).toBeGreaterThan(0);
    expect(compareVersion('0.5', '0.5.0')).toBe(0);
    expect(compareVersion('0.4', '0.5.1')).toBeLessThan(0);
  });

  it('いちばん上が今の版', () => {
    expect(RELEASE_NOTES[0].version).toBe(VERSION);
  });

  it('前回の版より新しい版だけを目立たせ、古い版はたたむ', () => {
    const html = releaseNotesHtml('0.5.4');
    expect(html).toContain('前回遊んだ <b>v0.5.4</b> からの変更');
    const newer = RELEASE_NOTES.filter((n) => compareVersion(n.version, '0.5.4') > 0).length;
    expect(html).toContain(`（${newer}つの版）`);
    expect((html.match(/class="relnote new"/g) ?? []).length).toBe(newer);
    expect(html).toContain('<details class="relnote old"><summary>v0.5.4');
  });

  it('前回の版がわからないときは、全部を開いて出す', () => {
    const html = releaseNotesHtml(null);
    expect(html).not.toContain('relnew');
    expect(html).not.toContain('<details');
  });
});
