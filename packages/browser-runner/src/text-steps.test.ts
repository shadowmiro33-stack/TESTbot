import { describe, expect, it } from 'vitest';
import type { TextDriver } from './text-steps.js';

// 대기 시간은 모듈을 읽을 때 정해지므로, 짧게 바꾼 뒤 불러옴 (기본 6초는 테스트 제한 시간보다 김)
process.env.QA_TEXT_TIMEOUT_MS = '300';
const { locate, newTextState, runTextStep, NAV_NOT_FOUND } = await import('./text-steps.js');

/** 화면 모델: visible = 지금 보이는 문구, below = 스크롤해야 보이는 문구, popup = 화면을 덮은 팝업 */
function fakeDriver(opts: { visible: string[]; below?: string[]; belowAfter?: number; popup?: string; maxScroll?: number; appearAfterMs?: number }) {
  let scrolled = 0;
  let popup = opts.popup ?? null;
  let clock = 0;
  const log: string[] = [];
  const shown = () => {
    if (popup) return [popup];
    const v = [...opts.visible];
    if (opts.appearAfterMs !== undefined && clock < opts.appearAfterMs) v.splice(0, v.length);
    if (scrolled >= (opts.belowAfter ?? 2)) v.push(...(opts.below ?? []));
    return v;
  };
  const driver: TextDriver = {
    async tapOnce(c) { const hit = c.find((x) => shown().includes(x)); if (hit) log.push(`tap:${hit}`); return hit ?? null; },
    async visibleOnce(c) { return c.some((x) => shown().includes(x)); },
    async fillOnce(c) { return c.find((x) => shown().includes(x)) ?? null; },
    async goBack() { log.push('back'); },
    async scroll(d) {
      log.push(`scroll:${d}`);
      const max = opts.maxScroll ?? 3;
      if (d === 'down') { if (scrolled >= max) return false; scrolled++; return scrolled < max; }
      if (scrolled === 0) return false; scrolled--; return true;
    },
    async dismissPopup() { if (!popup) return null; const p = popup; popup = null; log.push(`close:${p}`); return '닫기'; },
    async sleep(ms) { clock += ms; }
  };
  return { driver, log, get scrolled() { return scrolled; } };
}

describe('locate: 기다리기 → 팝업 닫기 → 스크롤', () => {
  it('바로 보이면 스크롤하지 않음', async () => {
    const f = fakeDriver({ visible: ['저장'] });
    expect(await locate(f.driver, () => f.driver.tapOnce(['저장']), 10)).toBe('저장');
    expect(f.log).toEqual(['tap:저장']);
  });
  it('늦게 뜨는 요소는 기다렸다가 찾음', async () => {
    const f = fakeDriver({ visible: ['저장'], appearAfterMs: 900 });
    expect(await locate(f.driver, () => f.driver.tapOnce(['저장']), 5000)).toBe('저장');
  });
  it('팝업이 덮고 있으면 닫고 찾음 (기록 남김)', async () => {
    const f = fakeDriver({ visible: ['마이페이지'], popup: '이벤트 안내' });
    const state = newTextState();
    expect(await locate(f.driver, () => f.driver.tapOnce(['마이페이지']), 0, state)).toBe('마이페이지');
    expect(f.log[0]).toBe('close:이벤트 안내');
    expect(state.notes.join()).toContain('팝업');
  });
  it('아래쪽 요소는 스크롤해서 찾음 — 마지막 스크롤(더 못 내려감) 뒤 화면도 확인', async () => {
    const f = fakeDriver({ visible: ['목록'], below: ['이벤트 상세'], belowAfter: 3, maxScroll: 3 });
    const state = newTextState();
    expect(await locate(f.driver, () => f.driver.tapOnce(['이벤트 상세']), 0, state)).toBe('이벤트 상세');
    expect(state.notes.join()).toContain('스크롤 3회');
  });
  it('끝까지 없으면 null + 원래 위치로 되돌림', async () => {
    const f = fakeDriver({ visible: ['목록'], maxScroll: 2 });
    expect(await locate(f.driver, () => f.driver.tapOnce(['없는 버튼']), 0)).toBeNull();
    expect(f.scrolled).toBe(0);
  });
  it('scroll:false 옵션이면 스크롤하지 않음', async () => {
    const f = fakeDriver({ visible: ['목록'], below: ['아래'], belowAfter: 1 });
    expect(await locate(f.driver, () => f.driver.tapOnce(['아래']), 0, undefined, { scroll: false })).toBeNull();
    expect(f.log.some((l) => l.startsWith('scroll'))).toBe(false);
  });
});

describe('runTextStep 판정', () => {
  it('메뉴 경로를 못 찾으면 NAV_NOT_FOUND', async () => {
    const f = fakeDriver({ visible: [] , maxScroll: 0 });
    await expect(runTextStep(f.driver, { order: 1, action: 'tapText', value: '설정' } as never, newTextState())).rejects.toThrow(NAV_NOT_FOUND);
  });
  it('강한 검증 실패 → 예외(실패), 약한 검증 실패 → 재확인 사유', async () => {
    const f = fakeDriver({ visible: ['다른 문구'], maxScroll: 0 });
    await expect(runTextStep(f.driver, { order: 1, action: 'assertTextVisible', value: '저장되었습니다', metadata: { strength: 'strong' } } as never, newTextState())).rejects.toThrow('검증 실패');
    const state = newTextState();
    await runTextStep(f.driver, { order: 1, action: 'assertTextVisible', value: '프로필', metadata: { strength: 'weak' } } as never, state);
    expect(state.review.length).toBe(1);
  });
  it('보이지 않아야 함: 팝업을 닫거나 스크롤하지 않고 현재 화면만 확인', async () => {
    const f = fakeDriver({ visible: ['목록'], below: ['오류'], belowAfter: 1, popup: '공지' });
    await runTextStep(f.driver, { order: 1, action: 'assertTextVisible', value: '오류', metadata: { strength: 'strong', negate: true } } as never, newTextState());
    expect(f.log).toEqual([]);
  });
});
