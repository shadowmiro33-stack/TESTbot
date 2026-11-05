import { describe, expect, it } from 'vitest';
import { labelCandidates, parseSheetGrid, sheetCodeFor, type SheetGrid } from '@autohands/shared';
import { planFromAI, planSheetCase } from './sheet-planner.js';

/** 실무 QA 시트 형태를 흉내 낸 격자 (B열 ID, C~H 메뉴 1~6Depth, I 테스트 항목, J 결과 …) */
function sampleGrid(): SheetGrid {
  const g: SheetGrid = [];
  g[0] = [null, 'VERSE PLAY TEST 시나리오'];
  g[2] = [null, '테스트 OS 버전', '앱버전', '테스트 일시', '테스트 진행자'];
  g[3] = [null, '안드로이드 11', 'V.1.0.0', '2022-11-01', 'QA팀'];
  g[5] = [null, '구분', '표시'];
  g[6] = [null, '정상동작', 'O'];
  g[7] = [null, '실패', 'F'];
  g[8] = [null, '테스트불가', 'NT'];
  g[9] = [null, '재확인요청 ', 'check'];
  g[11] = [null, 'STEP (ID)', 'Menu Depth', null, null, null, null, null, '테스트 항목', '결과', '이슈현상', '발생빈도', '개발사 확인 ', '개발사 조치 사항', '접수일', '조치일', 'TJ검수'];
  g[12] = [null, null, '1Depth', '2Depth', '3Depth', '4Depth', '5Depth', '6Depth'];
  g[13] = [null, '01-01-0001', 'Song', null, null, null, null, null, '리스트명, 각 텍스트 버튼이 노출되는가', 'F', '인터랙션 없음'];
  g[14] = [null, '01-01-0002', null, '지금 뜨는 노래', null, null, null, null, 'CMS 등록된 10개의 곡이 전부 노출 되는가', 'O'];
  g[15] = [null, '01-01-0003', null, null, '콘텐츠 선택', null, null, null, '파트별 선택 화면으로 이동 되는가'];
  g[16] = [null, '01-01-0004', null, '최근 불렀던 노래 ', null, null, null, null, '최근 불렀던 노래가 없는 경우 "최근 불렀던 노래가 없습니다" 문구가 노출되는가'];
  g[17] = [null, '01-01-0005', null, null, null, null, null, null, '마지막으로 불렀던 노래가 노출 되는가'];
  g[18] = [null, '1. 배틀 구역'];
  g[19] = [null, '01-02-0001', '배틀 투표', null, null, null, null, null, '배틀투표의 콘텐츠에서 투표 버튼이 노출 되는가'];
  g[20] = [null, '01-02-0002', null, null, null, null, null, null, '노래 진행중 녹음 후 업로드가 되는가'];
  return g;
}

describe('QA 시나리오 시트 해석', () => {
  it('헤더·열 위치·결과 코드·메타를 찾고 메뉴 경로를 위 행에서 채운다', () => {
    const p = parseSheetGrid('Song', sampleGrid())!;
    expect(p.headerRow).toBe(12);
    expect(p.columns).toMatchObject({ id: 1, item: 8, depth: [2, 3, 4, 5, 6, 7], result: 9, issue: 10, received: 14 });
    expect(p.resultCodes).toEqual({ pass: 'O', fail: 'F', notTested: 'NT', check: 'check' });
    expect(p.meta['앱버전']).toBe('V.1.0.0');
    expect(p.cases.map((c) => c.externalId)).toEqual(['01-01-0001', '01-01-0002', '01-01-0003', '01-01-0004', '01-01-0005', '01-02-0001', '01-02-0002']);
    expect(p.cases[2]!.menuPath).toEqual(['Song', '지금 뜨는 노래', '콘텐츠 선택']);
    // 2Depth 가 바뀌면 3Depth 이하는 초기화
    expect(p.cases[3]!.menuPath).toEqual(['Song', '최근 불렀던 노래']);
    expect(p.cases[4]!.menuPath).toEqual(['Song', '최근 불렀던 노래']);
    // 1Depth 가 바뀌면 전체 초기화, 구역 제목 기록
    expect(p.cases[5]).toMatchObject({ menuPath: ['배틀 투표'], section: '1. 배틀 구역', row: 20 });
    expect(p.cases[0]!.previousResult).toBe('F');
  });

  it('양식이 아닌 시트는 null', () => {
    expect(parseSheetGrid('환경', [['No', '이름'], [1, '홍길동']])).toBeNull();
  });

  it('결과 코드 변환', () => {
    expect(['PASS', 'FAIL', 'REQUIREMENT_CHECK', 'SKIP'].map((r) => sheetCodeFor(r))).toEqual(['O', 'F', 'check', 'NT']);
  });

  it('메뉴 라벨 → 화면 텍스트 후보', () => {
    expect(labelCandidates('곡 선택 "사랑비"')[0]).toBe('사랑비');
    expect(labelCandidates('프로필이미지변경 버튼')).toContain('프로필이미지변경');
    expect(labelCandidates('[p]Recommend')).toEqual(['Recommend']);
  });
});

describe('실행 계획 변환', () => {
  const cases = parseSheetGrid('Song', sampleGrid())!.cases;

  it('따옴표 문구는 강한 검증(없으면 실패)', () => {
    const plan = planSheetCase(cases[3]!);
    expect(plan.mode).toBe('AUTO');
    expect(plan.steps.map((s) => s.action)).toEqual(['tapText', 'tapText', 'assertTextVisible']);
    expect(plan.steps.at(-1)).toMatchObject({ value: '최근 불렀던 노래가 없습니다', metadata: { strength: 'strong' } });
  });

  it('문장에서 추정한 대상은 약한 검증', () => {
    const plan = planSheetCase(cases[5]!);
    expect(plan.steps.at(-1)).toMatchObject({ action: 'assertTextVisible', value: '투표', metadata: { strength: 'weak' } });
  });

  it('메뉴 경로에서 누른 버튼을 항목에서 인용한 것은 기대 결과로 보지 않음', () => {
    const plan = planSheetCase({ menuPath: ['상세', '"<" 앱 이전버튼'], item: '상세보기화면에서 "<" 이전버튼 선택 시 관련영상모두보기 페이지로 이동하는가' });
    expect(plan.steps.some((s) => s.action === 'assertTextVisible' && s.value === '<')).toBe(false);
    expect(plan.steps.at(-1)).toMatchObject({ action: 'assertTextVisible', value: '관련영상모두보기', metadata: { strength: 'weak' } });
  });

  it('판정 근거가 없으면 사람 확인 요청', () => {
    const plan = planSheetCase(cases[4]!);
    expect(plan.steps.at(-1)!.action).toBe('manualCheck');
  });

  it('녹음·CMS 대조 등은 사람이 해야 하는 항목(NT)', () => {
    expect(planSheetCase(cases[6]!)).toMatchObject({ mode: 'MANUAL', reason: expect.stringContaining('녹음') });
    expect(planSheetCase(cases[1]!)).toMatchObject({ mode: 'MANUAL', reason: expect.stringContaining('CMS') });
    expect(planSheetCase({ menuPath: ['Song', '한곡을 부른뒤'], item: 'song main에 노출 되는가' }).mode).toBe('MANUAL');
  });

  it('[p] 페이지 표시는 선택적 확인, 클릭하지 않음', () => {
    const plan = planSheetCase({ menuPath: ['[p]Recommend', '앨범아이콘선택'], item: '관련영상모두보기 페이지로 이동하는가' });
    expect(plan.steps[0]).toMatchObject({ action: 'assertTextVisible', metadata: { optional: true } });
    expect(plan.steps[1]).toMatchObject({ action: 'tapText', value: '앨범아이콘선택' });
  });

  it('디바이스 이전버튼은 뒤로가기, 선행 케이스는 그 이동 단계를 이어서 수행', () => {
    const base = planSheetCase({ menuPath: ['배틀 투표', '썸네일선택'], item: '"상세보기" 문구가 노출되는가' });
    expect(planSheetCase({ menuPath: ['배틀 투표', '디바이스 이전버튼'], item: '목록으로 이동하는가' }).steps[1]!.action).toBe('goBack');
    const dependent = planSheetCase({ menuPath: ['배틀 투표', '썸네일선택', '0023 선행 작업후 X버튼 선택'], item: '"상세보기" 문구가 노출되는가' }, (ref) => (ref === '0023' ? base : undefined));
    expect(dependent.steps.map((s) => `${s.action}:${s.value}`)).toEqual(['tapText:배틀 투표', 'tapText:썸네일선택', 'tapText:X버튼 선택', 'assertTextVisible:상세보기']);
    const manualRef = planSheetCase({ menuPath: ['0023 선행 작업후 이전버튼'], item: 'x' }, () => ({ mode: 'MANUAL', reason: '녹음 필요', steps: [], checks: [] }));
    expect(manualRef).toMatchObject({ mode: 'MANUAL', reason: expect.stringContaining('선행 케이스 0023') });
    expect(planSheetCase({ menuPath: ['0099 선행 작업후 이전버튼'], item: 'x' }).mode).toBe('MANUAL');
  });

  it('AI 응답은 허용된 단계로만 조립', () => {
    const plan = planFromAI({ key: 'k', navigation: [{ label: '사랑비', kind: 'tap' }, { label: '설명', kind: 'skip' }], checks: [{ text: '업로드 완료', strength: 'strong' }] })!;
    expect(plan.steps.map((s) => s.action)).toEqual(['tapText', 'assertTextVisible']);
    expect(planFromAI({ key: 'k', manualReason: '카메라 필요' })!.mode).toBe('MANUAL');
  });
});
