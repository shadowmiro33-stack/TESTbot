/**
 * 모바일 앱 실행기 (Android / iOS) — Appium 서버와 W3C WebDriver 프로토콜로 통신
 *
 * - 추가 라이브러리 없이 fetch 로 Appium REST API 를 호출합니다.
 * - QA 시나리오 시트의 텍스트 기반 단계(tapText / assertTextVisible / goBack / manualCheck)를 웹과 같은 규칙으로 실행합니다.
 * - 케이스마다 앱을 종료→실행해 첫 화면에서 시작합니다(appId 가 있을 때).
 * - 기기 1대를 공유하므로 케이스는 순서대로 하나씩 실행해야 합니다.
 *
 * 준비물: Appium 2 서버 (+ uiautomator2 / xcuitest 드라이버), 연결된 기기 또는 에뮬레이터
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { maskSecretText } from '@autohands/core';
import type { TestStep } from '@autohands/shared';
import { NAV_NOT_FOUND, PERMISSION_ALLOW_TEXTS, POPUP_DISMISS_TEXTS, TEXT_ACTIONS, newTextState, reviewSummary, runTextStep, type TextDriver } from './text-steps.js';

export type AppTarget = {
  platform: 'ANDROID' | 'IOS';
  /** Appium 서버 주소 (예: http://127.0.0.1:4723) */
  appiumUrl: string;
  /** Appium capabilities (appium:deviceName, appium:appPackage, appium:app …) */
  capabilities: Record<string, unknown>;
  /** 케이스마다 재시작할 앱 ID (Android 패키지명 / iOS 번들 ID) */
  appId?: string;
  /** 앱 로그인에 쓸 테스트 계정 (없으면 기기에 로그인된 상태를 그대로 사용) */
  login?: { username: string; password: string };
};

export const LOGIN_FAILED_APP = 'APP_LOGIN_FAILED';

type AppCase = { id: string; title: string; steps: TestStep[] };
type AppResult = { result: 'PASS' | 'FAIL' | 'BLOCKED' | 'REQUIREMENT_CHECK'; actual: string; durationMs: number; screenshots: string[]; tracePath?: string; networkLogs: unknown[]; consoleLogs: string[] };

const ELEMENT_KEY = 'element-6066-11e4-a23f-4069-a6e9-14a53';

/** XPath 문자열 리터럴 (따옴표가 섞여도 안전하게) */
function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
}

/** 화면 텍스트 → 요소 XPath (정확히 일치 / 포함) */
export function appiumXPathFor(platform: 'ANDROID' | 'IOS', text: string, exact: boolean): string {
  const q = xpathLiteral(text);
  const attrs = platform === 'ANDROID' ? ['@text', '@content-desc'] : ['@label', '@name', '@value'];
  const cond = attrs.map((a) => (exact ? `${a}=${q}` : `contains(${a}, ${q})`)).join(' or ');
  return `//*[${cond}]`;
}

export class AppiumClient {
  sessionId?: string;
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 60_000) {}

  async request<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${route}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new Error(`Appium 서버(${this.baseUrl})에 연결할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    const data = (await response.json().catch(() => ({}))) as { value?: any };
    if (!response.ok || (data.value && typeof data.value === 'object' && 'error' in data.value)) {
      const v = data.value ?? {};
      const err = new Error(`Appium ${method} ${route} 실패: ${v.error ?? response.status} ${String(v.message ?? '').split('\n')[0]}`) as Error & { code?: string };
      err.code = v.error;
      throw err;
    }
    return data.value as T;
  }

  private s(route = '') {
    if (!this.sessionId) throw new Error('Appium 세션이 없습니다.');
    return `/session/${this.sessionId}${route}`;
  }

  async status() { return this.request<{ ready?: boolean; message?: string }>('GET', '/status'); }
  async createSession(capabilities: Record<string, unknown>) {
    const value = await this.request<{ sessionId: string; capabilities: Record<string, unknown> }>('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } });
    this.sessionId = value.sessionId;
    return value;
  }
  async findElements(xpath: string): Promise<string[]> {
    const list = await this.request<Array<Record<string, string>>>('POST', this.s('/elements'), { using: 'xpath', value: xpath });
    return (list ?? []).map((e) => e[ELEMENT_KEY] ?? e.ELEMENT!).filter(Boolean);
  }
  async isDisplayed(el: string) { return Boolean(await this.request<boolean>('GET', this.s(`/element/${el}/displayed`)).catch(() => false)); }
  async click(el: string) { await this.request('POST', this.s(`/element/${el}/click`), {}); }
  async back() { await this.request('POST', this.s('/back'), {}); }
  async setValue(el: string, text: string) {
    await this.request('POST', this.s(`/element/${el}/clear`), {}).catch(() => undefined);
    await this.request('POST', this.s(`/element/${el}/value`), { text, value: [...text] });
  }
  async screenshot(): Promise<Buffer> { return Buffer.from(await this.request<string>('GET', this.s('/screenshot')), 'base64'); }
  async source(): Promise<string> { return this.request<string>('GET', this.s('/source')); }
  async execute(script: string, args: unknown[] = []) { return this.request('POST', this.s('/execute/sync'), { script, args }); }
  async windowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.request('GET', this.s('/window/rect')).catch(() => ({ x: 0, y: 0, width: 1080, height: 2340 })) as Promise<{ x: number; y: number; width: number; height: number }>;
  }
  /** 화면 가운데 영역을 한 화면 분량 스크롤. 더 움직일 수 없으면 false */
  async scrollScreen(platform: 'ANDROID' | 'IOS', direction: 'down' | 'up'): Promise<boolean> {
    const r = await this.windowRect();
    if (platform === 'ANDROID') {
      // UiAutomator2: 더 스크롤할 수 있으면 true 를 돌려줌
      const more = await this.execute('mobile: scrollGesture', [{ left: Math.round(r.width * 0.1), top: Math.round(r.height * 0.2), width: Math.round(r.width * 0.8), height: Math.round(r.height * 0.6), direction, percent: 0.75 }]).catch(() => undefined);
      if (typeof more === 'boolean') return more;
    } else {
      const ok = await this.execute('mobile: swipe', [{ direction: direction === 'down' ? 'up' : 'down' }]).then(() => true, () => false);
      if (ok) return true;
    }
    // 일반 W3C 손가락 끌기 (위 명령을 지원하지 않는 드라이버)
    const x = Math.round(r.width / 2);
    const [from, to] = direction === 'down' ? [r.height * 0.75, r.height * 0.3] : [r.height * 0.3, r.height * 0.75];
    await this.request('POST', this.s('/actions'), { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, x, y: Math.round(from) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 100 },
      { type: 'pointerMove', duration: 500, x, y: Math.round(to) }, { type: 'pointerUp', button: 0 }
    ] }] });
    return true;
  }
  async deleteSession() {
    if (!this.sessionId) return;
    await this.request('DELETE', this.s()).catch(() => undefined);
    this.sessionId = undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function appTextDriver(client: AppiumClient, platform: 'ANDROID' | 'IOS'): TextDriver {
  const visibleElement = async (text: string) => {
    for (const exact of [true, false]) {
      const els = await client.findElements(appiumXPathFor(platform, text, exact)).catch(() => []);
      for (const el of els.slice(0, 5)) if (await client.isDisplayed(el)) return el;
    }
    return null;
  };
  const field = platform === 'ANDROID' ? "contains(@class,'EditText')" : "(contains(@type,'TextField') or contains(@type,'SecureTextField') or contains(@type,'TextView'))";
  return {
    async tapOnce(candidates) {
      for (const c of candidates) {
        const el = await visibleElement(c);
        if (!el) continue;
        // 화면 전환 중 요소가 사라지면(stale) 다음 시도에서 다시 찾음
        if (!(await client.click(el).then(() => true, () => false))) continue;
        await sleep(700);
        return c;
      }
      return null;
    },
    async visibleOnce(candidates) {
      for (const c of candidates) if (await visibleElement(c)) return true;
      return false;
    },
    async fillOnce(candidates, value) {
      for (const c of candidates) {
        // 입력 칸 자체(힌트·설명)로 찾고, 없으면 라벨 문구 바로 다음의 입력 칸
        const q = appiumXPathFor(platform, c, false).slice(4, -1);
        for (const xpath of [`//*[${field} and (${q} or contains(@hint, '${c.replace(/'/g, '')}'))]`, `//*[${q}]/following::*[${field}][1]`]) {
          const els = await client.findElements(xpath).catch(() => []);
          for (const el of els.slice(0, 3)) {
            if (!(await client.isDisplayed(el))) continue;
            if (await client.setValue(el, value).then(() => true, () => false)) { await sleep(300); return c; }
          }
        }
      }
      return null;
    },
    async goBack() { await client.back(); await sleep(500); },
    async scroll(direction) { return client.scrollScreen(platform, direction); },
    async dismissPopup() {
      // 권한 요청(시스템 대화상자) → 허용, 공지·광고 팝업 → 닫기 계열만 누름 (확인·동의 같은 확정 버튼은 누르지 않음)
      for (const text of [...PERMISSION_ALLOW_TEXTS, ...POPUP_DISMISS_TEXTS]) {
        const isPermission = PERMISSION_ALLOW_TEXTS.includes(text);
        const xpath = isPermission && platform === 'ANDROID'
          ? `//*[contains(@resource-id,'permission') and @text=${JSON.stringify(text).replace(/"/g, "'")}]`
          : appiumXPathFor(platform, text, true);
        const els = await client.findElements(xpath).catch(() => []);
        for (const el of els.slice(0, 2)) {
          if (!(await client.isDisplayed(el))) continue;
          if (await client.click(el).then(() => true, () => false)) return text;
        }
      }
      return null;
    },
    sleep
  };
}

export class AppSession {
  private constructor(private readonly client: AppiumClient, private readonly target: AppTarget) {}

  static async open(target: AppTarget): Promise<AppSession> {
    const client = new AppiumClient(target.appiumUrl);
    await client.createSession({ platformName: target.platform === 'ANDROID' ? 'Android' : 'iOS', ...target.capabilities });
    const session = new AppSession(client, target);
    if (target.login?.username && target.login.password) {
      try {
        await session.login(target.login.username, target.login.password);
      } catch (error) {
        await client.deleteSession();
        throw error;
      }
    }
    return session;
  }

  /**
   * 앱 로그인 (등록한 테스트 계정)
   * - 비밀번호 입력 칸이 보이면 로그인 화면으로 보고, 아이디·비밀번호를 넣은 뒤 로그인 버튼을 누름
   * - 비밀번호 칸이 없으면 이미 로그인된 상태로 보고 넘어감 (noReset 이라 이후 케이스에서도 유지)
   */
  async login(username: string, password: string) {
    const { platform } = this.target;
    await this.restartApp();
    const driver = appTextDriver(this.client, platform);
    for (let i = 0; i < 2; i++) if (!(await driver.dismissPopup?.())) break;
    const pwXpath = platform === 'ANDROID' ? "//*[@password='true']" : '//XCUIElementTypeSecureTextField';
    const userXpath = platform === 'ANDROID' ? "//*[contains(@class,'EditText') and not(@password='true')]" : '//XCUIElementTypeTextField';
    const firstShown = async (xpath: string) => {
      for (const el of (await this.client.findElements(xpath).catch(() => [])).slice(0, 3)) if (await this.client.isDisplayed(el)) return el;
      return null;
    };
    const pw = await firstShown(pwXpath);
    if (!pw) return 'already';
    const user = await firstShown(userXpath);
    if (!user) throw new Error(`${LOGIN_FAILED_APP}: 로그인 화면에서 아이디 입력 칸을 찾지 못했습니다.`);
    await this.client.setValue(user, username);
    await this.client.setValue(pw, password);
    let tapped = false;
    for (const text of ['로그인', '로그인하기', 'Login', 'LOG IN', 'Log in', 'Sign in', 'SIGN IN']) {
      const els = await this.client.findElements(appiumXPathFor(platform, text, true)).catch(() => []);
      // 제목과 버튼이 같은 문구일 수 있어 화면 아래쪽(마지막) 요소를 누름
      for (const el of els.slice().reverse()) {
        if (!(await this.client.isDisplayed(el))) continue;
        if (await this.client.click(el).then(() => true, () => false)) { tapped = true; break; }
      }
      if (tapped) break;
    }
    if (!tapped) throw new Error(`${LOGIN_FAILED_APP}: 로그인 버튼을 찾지 못했습니다.`);
    await sleep(Number(process.env.QA_APP_LOGIN_WAIT_MS ?? 3000) || 3000);
    if (await firstShown(pwXpath)) throw new Error(`${LOGIN_FAILED_APP}: 로그인 후에도 로그인 화면이 그대로입니다. 등록한 테스트 계정을 확인하세요.`);
    return 'logged-in';
  }

  /** 앱을 종료했다가 다시 실행 → 첫 화면에서 시작 */
  private async restartApp() {
    const { appId, platform } = this.target;
    if (!appId) return;
    const arg = platform === 'ANDROID' ? { appId } : { bundleId: appId };
    await this.client.execute('mobile: terminateApp', [arg]).catch(() => undefined);
    await this.client.execute('mobile: activateApp', [arg]);
    await sleep(Number(process.env.QA_APP_LAUNCH_WAIT_MS ?? 2500) || 2500);
  }

  async executeCase(testCase: AppCase, options: { outputDir: string }): Promise<AppResult> {
    const started = Date.now();
    await mkdir(options.outputDir, { recursive: true });
    const state = newTextState();
    const driver = appTextDriver(this.client, this.target.platform);
    const screenshots: string[] = [];
    const shot = async (name: string) => {
      const p = path.join(options.outputDir, name);
      try { await writeFile(p, await this.client.screenshot()); screenshots.push(p); } catch { /* 캡처 실패는 결과에 영향 없음 */ }
    };
    let current: TestStep | undefined;
    try {
      await this.restartApp();
      await shot('01_before.png');
      for (const step of [...testCase.steps].sort((a, b) => a.order - b.order)) {
        current = step;
        if (TEXT_ACTIONS.has(step.action)) await runTextStep(driver, step, state);
        else if (step.action === 'wait') await sleep(Number(step.value ?? 500));
        else throw new Error(`앱에서는 '${step.action}' 단계를 실행할 수 없습니다. (웹 전용 단계)`);
      }
      current = undefined;
      await shot('result.png');
      if (state.review.length) return { result: 'REQUIREMENT_CHECK', actual: maskSecretText(reviewSummary(state)), durationMs: Date.now() - started, screenshots, networkLogs: [], consoleLogs: [] };
      const note = state.notes.length ? ` (참고: ${state.notes.slice(0, 3).join(' / ')})` : '';
      return { result: 'PASS', actual: `모든 단계와 검증을 통과했습니다.${note}`, durationMs: Date.now() - started, screenshots, networkLogs: [], consoleLogs: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await shot('02_fail.png');
      await writeFile(path.join(options.outputDir, 'screen.xml'), await this.client.source().catch(() => '')).catch(() => undefined);
      const stepInfo = current ? `[step ${current.order}: ${current.action} '${String(current.value ?? '').slice(0, 40)}'] ` : '';
      // 앱/서버 연결 문제는 결함이 아니라 실행 환경 문제 → BLOCKED
      const environmentProblem = /Appium 서버|세션이 없습니다|invalid session|session not created/i.test(message);
      const result = environmentProblem ? 'BLOCKED' : message.includes(NAV_NOT_FOUND) ? 'REQUIREMENT_CHECK' : 'FAIL';
      return { result, actual: maskSecretText(`${stepInfo}${message.replace(`${NAV_NOT_FOUND}: `, '')}`), durationMs: Date.now() - started, screenshots, networkLogs: [], consoleLogs: [] };
    }
  }

  async close() { await this.client.deleteSession(); }
}
