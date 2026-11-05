import { describe, expect, it } from 'vitest';
import { parseSheetGrid, type SheetGrid } from '@autohands/shared';
import { formatStepsText, menuPathFromSteps, parseStepsText, planFromSteps } from './step-planner.js';
import { planSheetCase } from './sheet-planner.js';

const nav = [{ action: '「마이페이지」 탭을 누른다' }, { action: '「프로필 편집」 버튼을 누른다' }];

describe('단계 문장 → 실행 계획 (기법 기반 TC)', () => {
  it('「」 는 누를 대상, 입력 단계는 data 값으로 입력, " " 문구는 강한 검증', () => {
    const plan = planFromSteps({
      steps: [...nav, { action: '「닉네임」 필드에 값을 입력한다', data: '닉네임=가나' }, { action: '「저장」 버튼을 누른다' }],
      expectedResult: '"닉네임이 변경되었습니다" 문구가 표시된다',
      preconditions: ['로그인한 사용자로 접속해 있다']
    });
    expect(plan.mode).toBe('AUTO');
    expect(plan.steps.map((s) => `${s.action}:${s.value}`)).toEqual(['tapText:마이페이지', 'tapText:프로필 편집', 'fillText:닉네임', 'tapText:저장', 'assertTextVisible:닉네임이 변경되었습니다']);
    expect(plan.steps[2]!.metadata).toMatchObject({ data: '가나' });
    expect(plan.steps.at(-1)!.metadata).toMatchObject({ strength: 'strong' });
  });

  it('빈 값 입력도 실행한다 (data 가 빈 문자열)', () => {
    const plan = planFromSteps({ steps: [{ action: '「닉네임」 필드에 값을 입력한다', data: '' }], expectedResult: '"닉네임을 입력해 주세요" 문구가 표시된다' });
    expect(plan.steps[0]).toMatchObject({ action: 'fillText', metadata: { data: '' } });
  });

  it('로그인 외 사전 조건이 있으면 실패 대신 재확인(약한 검증)', () => {
    const plan = planFromSteps({ steps: nav, expectedResult: '"쿠폰 3장" 이 표시된다', preconditions: ['쿠폰을 3장 보유하고 있다'] });
    expect(plan.steps.at(-1)!.metadata).toMatchObject({ strength: 'weak' });
  });

  it('해석하지 못한 단계에서 멈추고 사람 확인 (그 뒤 검증은 하지 않음)', () => {
    const plan = planFromSteps({ steps: [...nav, { action: '서버 응답이 늦어질 때까지 반복한다' }, { action: '「저장」 버튼을 누른다' }], expectedResult: '"저장되었습니다" 문구가 표시된다' });
    expect(plan.steps.map((s) => s.action)).toEqual(['tapText', 'tapText', 'manualCheck']);
    expect(plan.checks).toEqual([]);
  });

  it('API 응답만 확인하는 케이스와 결제는 테스트불가', () => {
    expect(planFromSteps({ steps: [{ action: 'PATCH /users/me 를 호출한다' }], expectedResult: '409 상태 코드를 반환한다' }).mode).toBe('MANUAL');
    expect(planFromSteps({ steps: nav, expectedResult: '결제가 완료된다' }).mode).toBe('MANUAL');
  });

  it('"표시되지 않는다" 는 보이지 않아야 함(약한 검증)', () => {
    const plan = planFromSteps({ steps: nav, expectedResult: '"저장" 버튼이 표시되지 않는다' });
    expect(plan.steps.at(-1)!.metadata).toMatchObject({ negate: true, strength: 'weak' });
  });

  it('단계 텍스트 왕복 · 메뉴 경로 추출', () => {
    const steps = [...nav, { action: '「닉네임」 필드에 값을 입력한다', data: '닉네임=가나' }];
    expect(parseStepsText(formatStepsText(steps))).toEqual(steps);
    expect(menuPathFromSteps(steps)).toEqual(['마이페이지', '프로필 편집', '닉네임']);
  });

  it('"단계" 열이 있는 시트는 단계 문장으로 실행', () => {
    const g: SheetGrid = [];
    g[0] = [null, 'STEP (ID)', 'Menu Depth', null, null, null, null, null, '테스트 항목', '결과', '이슈현상', '단계', '사전조건'];
    g[1] = [null, null, '1Depth', '2Depth', '3Depth', '4Depth', '5Depth', '6Depth'];
    g[2] = [null, '01-01-0001', '마이페이지', '프로필 편집', null, null, null, null, '"닉네임이 변경되었습니다" 문구가 표시된다', null, null, formatStepsText([...nav, { action: '「저장」 버튼을 누른다' }]), '로그인한 사용자'];
    const sheet = parseSheetGrid('닉네임', g)!;
    expect(sheet.columns).toMatchObject({ steps: 11, precondition: 12 });
    const plan = planSheetCase(sheet.cases[0]!);
    expect(plan.steps.map((s) => s.action)).toEqual(['tapText', 'tapText', 'tapText', 'assertTextVisible']);
  });
});
