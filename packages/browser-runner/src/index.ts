import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { isDangerousAction, maskRequestBody, maskSecretText, maskSecrets, maskUrl } from '@autohands/core';
import type { DiscoveryResult, DiscoveredControl, TestStep } from '@autohands/shared';
import { NAV_NOT_FOUND, POPUP_DISMISS_TEXTS, TEXT_ACTIONS, newTextState, reviewSummary, runTextStep, type TextDriver, type TextStepState } from './text-steps.js';

export { NAV_NOT_FOUND, runTextStep, newTextState, reviewSummary, type TextDriver, type TextStepState } from './text-steps.js';
export { AppSession, AppiumClient, appiumXPathFor, type AppTarget } from './app-session.js';

export type LoginInput = { url: string; username?: string; password?: string };
export type RunCase = { id: string; title: string; steps: TestStep[]; expected?: unknown; strategy: string };
export type ExecutionResult = { result: 'PASS' | 'FAIL' | 'BLOCKED' | 'REQUIREMENT_CHECK'; actual: string; durationMs: number; screenshots: string[]; tracePath?: string; networkLogs: unknown[]; consoleLogs: string[] };

const LOGIN_TIMEOUT_MS = 15_000;
/** SPA 가 로그인 화면/본문을 그릴 때까지 기다리는 최대 시간 (롱폴링 사이트에서 케이스마다 오래 멈추지 않도록 제한) */
const SPA_SETTLE_MS = 4_000;
export const LOGIN_FAILED = 'LOGIN_FAILED';
const BLOCKED_MARKER = 'BLOCKED_PRODUCTION_DANGEROUS_ACTION';
/** 401/403: 결함이 아니라 '접근 권한/인증이 필요한 페이지' → REQUIREMENT_CHECK 로 분류 */
const AUTH_REQUIRED_PAGE = 'AUTH_REQUIRED_PAGE';
/** 같은 출처의 이미지·스크립트·스타일·폰트가 4xx/5xx 로 깨진 경우 FAIL */
const BROKEN_RESOURCE_TYPES = new Set(['image', 'script', 'stylesheet', 'font', 'media']);

async function launch(): Promise<Browser> { return chromium.launch({ headless: true }); }

/** 차단해야 하는 URL 이면 true 를 반환하는 검사 함수 (SSRF 방지: 메타데이터·금지 대역으로의 리다이렉트/하위 요청 차단) */
export type RequestGuard = (url: string) => boolean;
export const BLOCKED_REQUEST = 'BLOCKED_TARGET_REQUEST';
/** 차단된 요청 기록. navigations 는 페이지 이동(리다이렉트 포함) 자체가 막힌 경우 */
type GuardLog = { requests: string[]; navigations: string[] };
const newGuardLog = (): GuardLog => ({ requests: [], navigations: [] });
async function installGuard(context: BrowserContext, guard: RequestGuard | undefined, log: GuardLog) {
  if (!guard) return;
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = request.url();
    if (guard(url)) {
      log.requests.push(url);
      if (request.isNavigationRequest()) log.navigations.push(url);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}
/**
 * 페이지 이동이 차단됐는지 확인. (Chromium 은 리다이렉트 단계에서 막힌 이동을 goto 오류로 알려주지 않을 수 있어
 * 이후 단계에서 엉뚱한 오류가 나므로, 이동 직후 명시적으로 검사합니다.)
 */
function assertNotBlockedNavigation(log: GuardLog, from: string, page?: Page, guard?: RequestGuard) {
  // 차단 기록은 goto 가 끝난 뒤에 남을 수 있으므로, 현재 페이지 주소 자체도 정책으로 검사
  if (page && guard && guard(page.url()) && !log.navigations.includes(page.url())) log.navigations.push(page.url());
  if (log.navigations.length) {
    throw new Error(`${BLOCKED_REQUEST}: ${maskUrl(from)} 이동 중 정책상 금지된 주소(${log.navigations.slice(0, 2).map(maskUrl).join(', ')})로 이동하려 해 차단했습니다.`);
  }
}

type RawControl = { testId?: string | null; aria?: string | null; name?: string | null; id?: string | null; tag: string; type?: string | null; path?: string | null };
function selectorFor(el: RawControl) {
  const escape = (value: string) => value.replace(/["\\]/g, '\\$&');
  if (el.testId) return `[data-testid="${escape(el.testId)}"]`;
  if (el.aria) return `${el.tag}[aria-label="${escape(el.aria)}"]`;
  if (el.name) return `${el.tag}[name="${escape(el.name)}"]`;
  // 속성 선택자를 쓰면 React(:r1:) 등 특수문자 id 도 안전하게 지정됩니다.
  if (el.id) return `[id="${escape(el.id)}"]`;
  // 형제 기준 nth-of-type 경로 (페이지 안에서 계산)
  return el.path || el.tag;
}

/**
 * 로그인 화면을 감지해 로그인하고, 성공 여부를 검증합니다.
 * 로그인 시도 후에도 비밀번호 필드가 그대로 보이면 LOGIN_FAILED 오류를 던집니다.
 */
async function detectAndLogin(page: Page, input: LoginInput): Promise<{ attempted: boolean }> {
  await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error: Error) => {
    if (String(error?.message).includes('ERR_BLOCKED_BY_CLIENT')) {
      throw new Error(`${BLOCKED_REQUEST}: 대상 URL 이 정책상 금지된 주소로 이동(리다이렉트)하여 차단했습니다. (${maskUrl(input.url)})`);
    }
    throw error;
  });
  // SPA 는 domcontentloaded 이후에 로그인 화면을 그리므로, 비밀번호 필드가 나타나거나 네트워크가 잠잠해질 때까지 기다림
  // (서버 렌더링 로그인 화면은 즉시 통과, 로그인 없는 페이지는 network idle 시점에 통과)
  await Promise.race([
    page.locator('input[type=password]:visible').first().waitFor({ state: 'visible', timeout: SPA_SETTLE_MS }),
    page.waitForLoadState('networkidle', { timeout: SPA_SETTLE_MS })
  ]).catch(() => undefined);
  if (!input.username && !input.password) return { attempted: false };

  const passwordField = page.locator('input[type=password]:visible').first();
  if (!(await passwordField.count())) return { attempted: false };
  if (!input.password) throw new Error(`${LOGIN_FAILED}: 로그인 화면이 있지만 등록된 비밀번호가 없습니다.`);

  // 비밀번호 필드가 속한 form 안에서 우선 탐색 (검색창 등을 사용자명으로 오인하지 않도록)
  const form = passwordField.locator('xpath=ancestor::form[1]');
  const scope: Locator | Page = (await form.count()) ? form : page;
  // CSS 합집합(,)은 문서 순서로 매칭되므로, 우선순위대로 하나씩 시도합니다.
  const usernameCandidates = [
    'input[autocomplete=username]', 'input[type=email]', 'input[name*=user i]', 'input[name*=email i]',
    'input[name*=login i]', 'input[id*=user i]', 'input[name*=id i]', 'input[type=text]', 'input:not([type])'
  ];
  let username: Locator | undefined;
  for (const candidate of usernameCandidates) {
    const locator = scope.locator(`${candidate}:visible`).first();
    if (await locator.count()) { username = locator; break; }
  }
  // 사용자명 칸이 없는 로그인(접근 토큰·PIN·관리자 비밀번호만 받는 화면)은 비밀번호만 입력
  if (username && input.username) await username.fill(input.username);
  await passwordField.fill(input.password);

  const beforeUrl = page.url();
  const namedSubmit = scope.getByRole('button', { name: /login|log in|sign in|로그인|접속/i }).first();
  const typedSubmit = scope.locator('button[type=submit]:visible, input[type=submit]:visible').first();
  if (await namedSubmit.count()) await namedSubmit.click();
  else if (await typedSubmit.count()) await typedSubmit.click();
  else await passwordField.press('Enter');

  // URL 변경 또는 비밀번호 필드 사라짐 중 먼저 오는 것을 기다림
  await Promise.race([
    page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: LOGIN_TIMEOUT_MS }),
    page.locator('input[type=password]:visible').first().waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS })
  ]).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

  if (await page.locator('input[type=password]:visible').count()) {
    throw new Error(`${LOGIN_FAILED}: 로그인 시도 후에도 로그인 화면이 유지됩니다. 계정 정보 또는 로그인 화면 구조를 확인하세요. (URL: ${maskUrl(page.url())})`);
  }
  return { attempted: true };
}

export async function login(input: LoginInput) {
  const browser = await launch();
  try { const page = await browser.newPage(); await detectAndLogin(page, input); return { success: true, currentUrl: page.url(), title: await page.title() }; }
  finally { await browser.close(); }
}

// 화면 구조 스냅샷. 주의: tsx(esbuild keepNames) 환경에서 함수 직렬화 문제를 피하려고 문자열로 평가합니다.
const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cssPath = (el) => {
    const parts = []; let node = el; let anchored = false;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); anchored = true; break; }
      const tag = node.tagName.toLowerCase(); const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    if (!anchored) parts.unshift('body');
    return parts.join(' > ');
  };
  const elements = (query) => Array.from(document.querySelectorAll(query)).filter(visible).map((el) => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.id, testId: el.dataset.testid, aria: el.getAttribute('aria-label'), path: cssPath(el),
    label: el.getAttribute('aria-label') || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent?.trim() : '') || el.closest('label')?.textContent?.trim().slice(0, 60) || el.textContent?.trim().slice(0, 100),
    text: (el.textContent || el.getAttribute('value') || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    inForm: Boolean(el.closest('form')),
    required: el.hasAttribute('required'), maxLength: el.hasAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : undefined, min: el.getAttribute('min'), max: el.getAttribute('max')
  }));
  return { title: document.title, links: Array.from(document.querySelectorAll('a[href]')).filter(visible).map((a) => a.href), forms: document.forms.length, inputs: elements('input:not([type=hidden]), select, textarea'), buttons: elements('button, input[type=submit], [role=button]') };
})()`;
type RawSnapshot = { title: string; links: string[]; forms: number; inputs: any[]; buttons: any[] };
const takeSnapshot = (page: Page) => page.evaluate(SNAPSHOT_SCRIPT) as Promise<RawSnapshot>;
const mapControl = (item: any): DiscoveredControl => ({ selector: selectorFor(item), tag: item.tag, type: item.type ?? undefined, name: item.name ?? undefined, label: item.label ?? undefined, required: item.required, maxLength: item.maxLength, min: item.min ?? undefined, max: item.max ?? undefined });
const settle = (page: Page, ms = 3_000) => page.waitForLoadState('networkidle', { timeout: ms }).catch(() => undefined);

/** 세션을 끊거나 데이터를 바꿀 수 있는 버튼은 탐색 중 클릭하지 않습니다. */
// ("새 ~/추가/등록" 버튼은 보통 입력 폼을 여는 버튼이므로 허용, "생성/실행/저장" 처럼 즉시 동작하는 버튼은 제외)
const NEVER_CLICK = /log ?out|sign ?out|로그아웃|저장|save|submit|제출|전송|send|확인|\bok\b|apply|적용|실행|\brun\b|start|시작|생성|create|generate|승인|approve|reset|초기화|import|업로드|upload|다운로드|download|재테스트|retest|취소|cancel/i;
const MAX_CLICKS_PER_PAGE = 6;

export type DiscoverOptions = {
  requestGuard?: RequestGuard;
  /** 운영 환경이면 버튼 클릭 탐색을 하지 않습니다(링크 이동만). */
  production?: boolean;
  /** false 면 버튼 클릭 탐색 비활성화 */
  exploreClicks?: boolean;
};

export async function discover(input: LoginInput, maxPages = 20, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const browser = await launch();
  const context = await browser.newContext();
  const guardLog = newGuardLog();
  await installGuard(context, options.requestGuard, guardLog);
  const page = await context.newPage();
  const endpointMap = new Map<string, { method: string; url: string; status?: number }>();
  const consoleErrors: string[] = [];
  page.on('response', (response) => {
    const req = response.request();
    if (['xhr', 'fetch'].includes(req.resourceType())) {
      const url = maskUrl(response.url());
      endpointMap.set(`${req.method()} ${url}`, { method: req.method(), url, status: response.status() });
    }
  });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(maskSecretText(msg.text())); });
  page.on('pageerror', (err) => consoleErrors.push(maskSecretText(`[uncaught] ${err.message}`)));
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined)); // confirm/alert 로 탐색이 멈추지 않도록
  const pages: DiscoveryResult['pages'] = [];
  const explore = options.exploreClicks !== false && !options.production;
  try {
    await detectAndLogin(page, input);
    assertNotBlockedNavigation(guardLog, input.url, page, options.requestGuard);
    const origin = new URL(page.url()).origin;
    const queue = [page.url()];
    const seen = new Set<string>();
    const enqueue = (link: string) => { try { const parsed = new URL(link); parsed.hash = ''; if (parsed.origin === origin && !seen.has(parsed.href)) queue.push(parsed.href); } catch {} };
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      const normalized = new URL(url); normalized.hash = '';
      if (seen.has(normalized.href) || normalized.origin !== origin) continue;
      seen.add(normalized.href);
      await page.goto(normalized.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      if (guardLog.navigations.length || options.requestGuard?.(page.url())) {
        // 내부 링크가 금지 주소로 리다이렉트 → 해당 페이지만 건너뛰고 계속 탐색
        consoleErrors.push(`[AUTOHANDS] ${maskUrl(normalized.href)} → 금지된 주소로 리다이렉트되어 건너뜀`);
        guardLog.navigations.length = 0;
        continue;
      }
      await settle(page);
      const snapshot = await takeSnapshot(page);
      const pageUrl = page.url();
      pages.push({ url: pageUrl, title: snapshot.title, links: snapshot.links, forms: snapshot.forms, inputs: snapshot.inputs.map(mapControl), buttons: snapshot.buttons.map(mapControl) });
      snapshot.links.forEach(enqueue);

      // ── SPA 화면 탐색: 링크 없이 버튼 클릭으로만 열리는 폼/모달을 찾습니다 ──
      if (!explore) continue;
      const knownInputs = new Set<string>(snapshot.inputs.map((i) => i.path));
      const tried = new Set<string>();
      const candidates = snapshot.buttons.filter((b) => {
        const text = String(b.text || b.aria || '').trim();
        if (!text || text.length > 40 || tried.has(text)) return false;
        tried.add(text);
        if (b.tag === 'input' || b.type === 'submit' || (b.inForm && b.type !== 'button')) return false; // 폼 제출 방지
        return !NEVER_CLICK.test(text) && !isDangerousAction(text);
      }).slice(0, MAX_CLICKS_PER_PAGE);

      for (const button of candidates) {
        if (pages.length >= maxPages) break;
        const text = String(button.text || button.aria).trim();
        const tag = button.tag === 'button' ? 'button' : '[role=button]';
        const triggerSelector = `${tag}:has-text("${text.replace(/["\\]/g, '\\$&')}") >> nth=0`;
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await settle(page);
          await page.locator(triggerSelector).click({ timeout: 3_000 });
          await settle(page, 2_000);
          if (guardLog.navigations.length || options.requestGuard?.(page.url())) { guardLog.navigations.length = 0; continue; }
          const after = await takeSnapshot(page);
          const afterUrl = new URL(page.url()); afterUrl.hash = '';
          if (afterUrl.origin !== origin) continue;
          if (afterUrl.href !== new URL(pageUrl).href.replace(/#.*$/, '')) { enqueue(afterUrl.href); continue; } // 라우팅된 새 화면 → 일반 페이지로 탐색
          const fresh = after.inputs.filter((i) => !knownInputs.has(i.path));
          if (!fresh.length) continue;
          fresh.forEach((i) => knownInputs.add(i.path));
          pages.push({
            url: pageUrl,
            title: `${after.title || snapshot.title} › ${text}`,
            links: [], forms: after.forms,
            inputs: after.inputs.map(mapControl), buttons: after.buttons.map(mapControl),
            trigger: { selector: triggerSelector, label: text }
          });
        } catch {
          /* 클릭 불가/시간 초과 버튼은 건너뜀 */
        }
      }
    }
    if (guardLog.requests.length) consoleErrors.push(`[AUTOHANDS] 정책상 차단된 요청 ${guardLog.requests.length}건: ${guardLog.requests.slice(0, 3).map(maskUrl).join(', ')}`);
    return { pages, networkEndpoints: [...endpointMap.values()], consoleErrors };
  } finally { await browser.close(); }
}

type StepContext = { production: boolean; lastDocumentStatus?: number; text: TextStepState; dialogs: string[] };

/** 화면 텍스트로 요소를 찾는 웹 드라이버 (QA 시나리오 시트 실행용) */
/** 화면을 덮은 레이어(고정 위치·dialog) 안에서 "닫기" 계열 버튼을 찾아 표시 — 찾은 문구 반환 */
const FIND_POPUP_CLOSE_SCRIPT = `(function (texts) {
  function overlay(el) {
    for (var e = el; e && e !== document.body; e = e.parentElement) {
      var s = getComputedStyle(e);
      if (s.position === 'fixed' || e.getAttribute('role') === 'dialog' || e.getAttribute('aria-modal') === 'true' || e.tagName === 'DIALOG') return true;
    }
    return false;
  }
  var els = Array.prototype.filter.call(document.querySelectorAll('button, a, [role=button], [aria-label], span, div'), function (el) {
    return el.tagName === 'BUTTON' || el.children.length === 0 || el.hasAttribute('aria-label');
  });
  for (var i = 0; i < texts.length; i++) {
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      var label = (el.innerText || el.getAttribute('aria-label') || '').trim();
      var r = el.getBoundingClientRect();
      if (label === texts[i] && r.width > 0 && r.height > 0 && overlay(el)) { el.setAttribute('data-autohands-dismiss', '1'); return texts[i]; }
    }
  }
  return null;
})`;

function webTextDriver(page: Page, dialogs: string[]): TextDriver {
  const attr = (c: string) => c.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const locatorsFor = (c: string): Locator[] => [
    page.getByRole('button', { name: c, exact: true }),
    page.getByRole('link', { name: c, exact: true }),
    page.getByRole('tab', { name: c, exact: true }),
    page.getByRole('menuitem', { name: c, exact: true }),
    page.getByText(c, { exact: true }),
    page.getByRole('button', { name: c }),
    page.getByRole('link', { name: c }),
    page.getByText(c),
    page.locator(`[aria-label*="${attr(c)}"], [title*="${attr(c)}"], img[alt*="${attr(c)}"]`)
  ];
  const firstVisible = async (c: string) => {
    for (const locator of locatorsFor(c)) {
      const first = locator.first();
      if (await first.isVisible().catch(() => false)) return first;
    }
    return null;
  };
  return {
    async tapOnce(candidates) {
      for (const c of candidates) {
        const target = await firstVisible(c);
        if (!target) continue;
        // 화면이 다시 그려지는 중이면 클릭이 실패할 수 있음 → 다음 시도에서 다시 (오류로 끝내지 않음)
        // 단, 팝업이 덮고 있어 클릭이 막힌 경우는 강제로 누르지 않음 (팝업을 누르게 됨) → 팝업 닫기 후 다시 시도
        const clicked = await target.click({ timeout: 2500 }).then(
          () => true,
          (e: Error) => (/intercepts pointer events/.test(e.message) ? false : target.click({ timeout: 1500, force: true }).then(() => true, () => false))
        );
        if (!clicked) continue;
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await page.waitForTimeout(300);
        return c;
      }
      return null;
    },
    async visibleOnce(candidates) {
      for (const c of candidates) {
        if (await page.getByText(c).first().isVisible().catch(() => false)) return true;
        if (await page.locator(`[aria-label*="${attr(c)}"], img[alt*="${attr(c)}"]`).first().isVisible().catch(() => false)) return true;
        // alert/confirm 으로 뜬 안내 문구도 화면 문구로 인정
        if (dialogs.some((d) => d.includes(c))) return true;
      }
      return false;
    },
    async fillOnce(candidates, value) {
      for (const c of candidates) {
        for (const locator of [page.getByLabel(c, { exact: true }), page.getByPlaceholder(c, { exact: true }), page.getByRole('textbox', { name: c }), page.getByLabel(c), page.getByPlaceholder(c)]) {
          const first = locator.first();
          if (!(await first.isVisible().catch(() => false))) continue;
          if (await first.fill(value, { timeout: 2500 }).then(() => true, () => false)) return c;
        }
      }
      return null;
    },
    async goBack() {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(300);
    },
    /** 화면 가운데에서 휠 스크롤 (페이지와 안쪽 스크롤 영역 모두 적용, 무한 스크롤 목록 로딩 유도) */
    async scroll(direction) {
      // 더 움직일 곳이 없으면 바로 false (짧은 화면에서 기다리지 않음)
      const room = await page.evaluate(`(function () { var el = document.scrollingElement || document.documentElement; return ${direction === 'down' ? 'el.scrollTop + window.innerHeight < el.scrollHeight - 2' : 'el.scrollTop > 0'}; })()`).catch(() => true);
      if (!room) return false;
      const before = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return `${el.scrollTop}|${document.body.innerText.length}`;
      }).catch(() => '');
      const vp = page.viewportSize() ?? { width: 1440, height: 900 };
      await page.mouse.move(vp.width / 2, vp.height / 2).catch(() => undefined);
      await page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * vp.height * 0.8).catch(() => undefined);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return `${el.scrollTop}|${document.body.innerText.length}`;
      }).catch(() => '');
      return before !== after;
    },
    async dismissPopup() {
      // 화면을 덮은 레이어(고정 위치·dialog) 안의 "닫기" 계열 버튼만 누름 — 일반 화면의 버튼은 건드리지 않음
      // 문자열 스크립트로 전달 (tsx/esbuild 가 함수에 넣는 __name 도우미가 브라우저에는 없어 실패하므로)
      const text = (await page.evaluate(`${FIND_POPUP_CLOSE_SCRIPT}(${JSON.stringify(POPUP_DISMISS_TEXTS)})`).catch(() => null)) as string | null;
      if (!text) return null;
      const target = page.locator('[data-autohands-dismiss="1"]').first();
      const ok = await target.click({ timeout: 2000 }).then(() => true, () => false);
      await page.evaluate("document.querySelectorAll('[data-autohands-dismiss]').forEach(function (e) { e.removeAttribute('data-autohands-dismiss'); })").catch(() => undefined);
      await page.waitForTimeout(300);
      return ok ? text : null;
    },
    async sleep(ms) { await page.waitForTimeout(ms); }
  };
}

async function assertNotDangerous(page: Page, step: TestStep, ctx: StepContext) {
  if (!ctx.production) return;
  const selector = step.selector ?? '';
  if (isDangerousAction(`${selector} ${String(step.value ?? '')}`) && step.action !== 'assertTextVisible' && step.action !== 'manualCheck') throw new Error(BLOCKED_MARKER);
  // 셀렉터가 의미 없는 경우(#btn-3 등)를 대비해 실제 클릭 대상의 표시 텍스트도 검사
  if (step.action === 'click' && selector) {
    const label = await page.locator(selector).first()
      .evaluate((el) => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${(el as HTMLInputElement).value ?? ''}`)
      .catch(() => '');
    if (isDangerousAction(label)) throw new Error(BLOCKED_MARKER);
  }
}

async function runStep(page: Page, step: TestStep, ctx: StepContext) {
  const selector = step.selector ?? '';
  await assertNotDangerous(page, step, ctx);
  if (TEXT_ACTIONS.has(step.action)) return runTextStep(webTextDriver(page, ctx.dialogs), step, ctx.text);
  switch (step.action) {
    case 'navigate': {
      const response = await page.goto(String(step.value), { waitUntil: 'domcontentloaded' });
      if (response) ctx.lastDocumentStatus = response.status();
      break;
    }
    case 'click': await page.locator(selector).click(); break;
    case 'input': await page.locator(selector).fill(String(step.value ?? '')); break;
    case 'select': await page.locator(selector).selectOption(String(step.value)); break;
    case 'check': await page.locator(selector).check(); break;
    case 'upload': await page.locator(selector).setInputFiles(String(step.value)); break;
    case 'wait': await page.waitForTimeout(Number(step.value ?? 500)); break;
    case 'assertText': await page.locator(selector).filter({ hasText: String(step.value) }).first().waitFor({ state: 'visible' }); break;
    case 'assertVisible': await page.locator(selector).first().waitFor({ state: 'visible' }); break;
    case 'assertHidden': await page.locator(selector).first().waitFor({ state: 'hidden' }); break;
    case 'assertUrl': if (!page.url().includes(String(step.value))) throw new Error(`URL 불일치: 기대 '${String(step.value)}' 포함, 실제 ${maskUrl(page.url())}`); break;
    case 'assertStatus': {
      const status = ctx.lastDocumentStatus;
      if (status === undefined) throw new Error('assertStatus: 확인할 문서 응답이 없습니다. navigate 단계 이후에 사용하세요.');
      const expected = step.value === undefined || step.value === null || step.value === '' ? undefined : Number(step.value);
      if (expected === undefined && (status === 401 || status === 403)) {
        throw new Error(`${AUTH_REQUIRED_PAGE}: 인증 또는 접근 권한이 필요한 페이지입니다 (HTTP ${status}). 해당 권한의 계정으로 별도 확인이 필요합니다.`);
      }
      if (expected !== undefined ? status !== expected : status >= 400) {
        throw new Error(`HTTP 상태 불일치: 기대 ${expected ?? '< 400'}, 실제 ${status}`);
      }
      break;
    }
    case 'assertInvalid':
    case 'assertValid': {
      const invalid = await page.locator(selector).evaluate((el) => {
        const validity = (el as HTMLInputElement).validity;
        return (validity ? !validity.valid : false) || el.getAttribute('aria-invalid') === 'true';
      });
      if (step.action === 'assertInvalid' && !invalid) throw new Error(`입력 검증 누락: '${selector}' 필드가 잘못된 값을 유효한 값으로 처리했습니다.`);
      if (step.action === 'assertValid' && invalid) throw new Error(`입력 검증 오류: '${selector}' 필드가 올바른 값을 거부했습니다.`);
      break;
    }
    case 'assertValueLength': {
      const rule = (step.value ?? {}) as { max?: number; equals?: number };
      const length = (await page.locator(selector).inputValue()).length;
      if (typeof rule.equals === 'number' && length !== rule.equals) throw new Error(`입력 길이 불일치: 기대 ${rule.equals}자, 실제 ${length}자`);
      if (typeof rule.max === 'number' && length > rule.max) throw new Error(`최대 길이 초과 허용: 최대 ${rule.max}자, 실제 ${length}자 입력됨`);
      break;
    }
    default:
      // 알 수 없는 action 이 조용히 PASS 되지 않도록 실패 처리
      throw new Error(`지원하지 않는 step action: ${String((step as { action?: unknown }).action)}`);
  }
}

type CaseOptions = { baseUrl: string; username?: string; password?: string; production: boolean; outputDir: string; viewport?: { width: number; height: number }; requestGuard?: RequestGuard };
type StorageState = Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>;

/** 하나의 케이스를 주어진 브라우저 안의 새 컨텍스트(격리된 쿠키/스토리지)에서 실행합니다. */
async function runCaseInBrowser(browser: Browser, testCase: RunCase, options: CaseOptions, storageState?: StorageState): Promise<ExecutionResult & { refreshedState?: StorageState }> {
  const started = Date.now(); await mkdir(options.outputDir, { recursive: true });
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 }, storageState });
  const guardLog = newGuardLog();
  await installGuard(context, options.requestGuard, guardLog);
  const page = await context.newPage(); const networkLogs: unknown[] = []; const consoleLogs: string[] = []; const screenshots: string[] = [];
  const serverErrors: string[] = [];
  const brokenResources: string[] = [];
  const ctx: StepContext = { production: options.production, text: newTextState(), dialogs: [] };
  // alert/confirm 대화상자는 문구를 기록하고 닫음 (열린 채로 두면 이후 모든 동작이 멈춤)
  // 운영 환경에서는 confirm("삭제하시겠습니까?" 등)을 취소해 실제 변경을 막음
  page.on('dialog', (d) => { ctx.dialogs.push(d.message()); void (options.production && d.type() === 'confirm' ? d.dismiss() : d.accept()).catch(() => undefined); });

  page.on('request', (r) => networkLogs.push({ type: 'request', method: r.method(), url: maskUrl(r.url()), headers: maskSecrets(r.headers()), postData: maskRequestBody(r.postData()) }));
  page.on('response', (r) => {
    const url = maskUrl(r.url());
    networkLogs.push({ type: 'response', status: r.status(), url });
    const type = r.request().resourceType();
    if (r.status() >= 500 && ['document', 'xhr', 'fetch'].includes(type)) serverErrors.push(`${r.status()} ${r.request().method()} ${url}`);
    if (type === 'document' && r.frame() === page.mainFrame()) ctx.lastDocumentStatus = r.status();
    if (r.status() >= 400 && BROKEN_RESOURCE_TYPES.has(type)) {
      try {
        const target = new URL(r.url());
        if (target.origin === new URL(options.baseUrl).origin && !target.pathname.endsWith('/favicon.ico')) brokenResources.push(`${r.status()} ${type} ${url}`);
      } catch { /* 무시 */ }
    }
  });
  page.on('console', (m) => consoleLogs.push(maskSecretText(`[${m.type()}] ${m.text()}`)));
  // 처리되지 않은 스크립트 예외 = 화면 기능이 깨졌을 가능성이 큰 실제 결함
  const scriptErrors: string[] = [];
  page.on('pageerror', (err) => {
    const message = maskSecretText(err.message.split('\n')[0] ?? String(err));
    scriptErrors.push(message);
    consoleLogs.push(`[pageerror] ${message}`);
  });

  const tracePath = path.join(options.outputDir, 'trace.zip');
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  let currentStep: TestStep | undefined;
  try {
    // 공유된 로그인 상태가 유효하면 로그인 화면이 나오지 않아 바로 통과합니다.
    // (세션 만료, sessionStorage 기반 토큰 등으로 로그인 화면이 다시 나오면 이 컨텍스트에서 재로그인)
    const { attempted } = await detectAndLogin(page, { url: options.baseUrl, username: options.username, password: options.password });
    assertNotBlockedNavigation(guardLog, options.baseUrl, page, options.requestGuard);
    const refreshedState = attempted && storageState ? await context.storageState() : undefined;
    const before = path.join(options.outputDir, '01_before.png'); await page.screenshot({ path: before, fullPage: true });
    for (const step of [...testCase.steps].sort((a, b) => a.order - b.order)) {
      currentStep = step;
      await runStep(page, step, ctx);
      assertNotBlockedNavigation(guardLog, page.url(), page, options.requestGuard);
    }
    currentStep = undefined;
    if (brokenResources.length) throw new Error(`깨진 리소스 ${brokenResources.length}건 (같은 사이트의 이미지/스크립트/스타일 로드 실패): ${[...new Set(brokenResources)].slice(0, 3).join(', ')}`);
    if (scriptErrors.length) throw new Error(`페이지 스크립트 오류 ${scriptErrors.length}건: ${[...new Set(scriptErrors)].slice(0, 2).join(' | ')}`);
    if (serverErrors.length) throw new Error(`서버 오류 응답 감지 (${serverErrors.length}건): ${serverErrors.slice(0, 3).join(', ')}`);
    if (guardLog.requests.length) throw new Error(`${BLOCKED_REQUEST}: 정책상 금지된 주소로의 요청 ${guardLog.requests.length}건 차단 (${guardLog.requests.slice(0, 3).map(maskUrl).join(', ')})`);
    const pass = path.join(options.outputDir, 'result.png'); await page.screenshot({ path: pass, fullPage: true }); screenshots.push(pass);
    await context.tracing.stop({ path: tracePath });
    // 텍스트 기반 단계에서 사람 확인이 필요하다고 기록된 경우 (추정 검증 실패, 판정 근거 없음)
    if (ctx.text.review.length) {
      return { result: 'REQUIREMENT_CHECK', actual: maskSecretText(reviewSummary(ctx.text)), durationMs: Date.now() - started, screenshots, tracePath, networkLogs, consoleLogs, refreshedState };
    }
    const note = ctx.text.notes.length ? ` (참고: ${ctx.text.notes.slice(0, 3).join(' / ')})` : '';
    return { result: 'PASS', actual: `모든 단계와 검증을 통과했습니다.${note}`, durationMs: Date.now() - started, screenshots, tracePath, networkLogs, consoleLogs, refreshedState };
  } catch (error) {
    // Playwright 오류의 색상 코드·호출 로그는 보고서에서 제외
    let message = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '').split(/\n\s*Call log:/)[0]!.trim();
    // 차단된 이동 때문에 생긴 2차 오류(컨텍스트 소멸 등)는 원인으로 바꿔서 보고
    if (guardLog.navigations.length && !message.includes(BLOCKED_REQUEST)) {
      message = `${BLOCKED_REQUEST}: 정책상 금지된 주소로의 이동 차단 (${guardLog.navigations.slice(0, 2).map(maskUrl).join(', ')})`;
    }
    const blocked = message.includes(BLOCKED_MARKER) || message.includes(BLOCKED_REQUEST) || guardLog.requests.length > 0;
    for (const [name, index] of [['01_before.png', 0], ['02_fail.png', 1], ['03_after.png', 2]] as const) { const p = path.join(options.outputDir, name); await page.screenshot({ path: p, fullPage: true }).catch(() => undefined); screenshots[index] = p; }
    await context.tracing.stop({ path: tracePath }).catch(() => undefined);
    await writeFile(path.join(options.outputDir, 'network.json'), JSON.stringify(networkLogs, null, 2));
    await writeFile(path.join(options.outputDir, 'console.log'), consoleLogs.join('\n'));
    const stepInfo = currentStep ? `[step ${currentStep.order}: ${currentStep.action}${currentStep.selector ? ` ${currentStep.selector}` : ''}] ` : '';
    const result = blocked ? 'BLOCKED' : message.includes(AUTH_REQUIRED_PAGE) || message.includes(NAV_NOT_FOUND) ? 'REQUIREMENT_CHECK' : 'FAIL';
    const display = message.replace(`${NAV_NOT_FOUND}: `, '');
    return { result, actual: maskSecretText(`${stepInfo}${display}`), durationMs: Date.now() - started, screenshots, tracePath, networkLogs, consoleLogs };
  } finally { await context.close().catch(() => undefined); }
}

/** 단건 실행 (브라우저를 띄우고 닫음). 대량 실행에는 ExecutionSession 을 사용하세요. */
export async function executeCase(testCase: RunCase, options: CaseOptions): Promise<ExecutionResult> {
  const browser = await launch();
  try {
    const { refreshedState: _ignored, ...result } = await runCaseInBrowser(browser, testCase, options);
    return result;
  } finally { await browser.close(); }
}

export type SessionOptions = { baseUrl: string; username?: string; password?: string; production: boolean; requestGuard?: RequestGuard };

/**
 * 실행(run) 단위 브라우저 세션.
 * - 브라우저는 한 번만 띄우고, 케이스마다 새 컨텍스트로 격리합니다.
 * - 로그인은 open() 에서 한 번 수행하고 storageState(쿠키/localStorage)를 모든 케이스가 공유합니다.
 * - 동시에 여러 케이스를 실행해도 안전합니다(컨텍스트 단위 격리).
 * - 로그인에 실패하면 open() 이 LOGIN_FAILED 오류를 던집니다 → 케이스마다 같은 실패를 반복하지 않습니다.
 */
export class ExecutionSession {
  private relaunching?: Promise<void>;
  private constructor(private browser: Browser, private readonly options: SessionOptions, private storageState?: StorageState) {}

  static async open(options: SessionOptions): Promise<ExecutionSession> {
    const browser = await launch();
    try {
      let state: StorageState | undefined;
      if (options.username && options.password) {
        const context = await browser.newContext();
        try {
          const guardLog = newGuardLog();
          await installGuard(context, options.requestGuard, guardLog);
          const page = await context.newPage();
          await detectAndLogin(page, { url: options.baseUrl, username: options.username, password: options.password });
          assertNotBlockedNavigation(guardLog, options.baseUrl, page, options.requestGuard);
          state = await context.storageState();
        } finally { await context.close().catch(() => undefined); }
      }
      return new ExecutionSession(browser, options, state);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  /** 브라우저 프로세스가 죽었으면 다시 띄웁니다(동시 호출 시 한 번만). */
  private async ensureBrowser() {
    if (this.browser.isConnected()) return;
    this.relaunching ??= launch().then((b) => { this.browser = b; }).finally(() => { this.relaunching = undefined; });
    await this.relaunching;
  }

  async executeCase(testCase: RunCase, options: { outputDir: string; viewport?: { width: number; height: number } }): Promise<ExecutionResult> {
    await this.ensureBrowser();
    const { refreshedState, ...result } = await runCaseInBrowser(this.browser, testCase, { ...this.options, ...options }, this.storageState);
    if (refreshedState) this.storageState = refreshedState; // 세션 만료 후 재로그인했다면 갱신된 상태를 이후 케이스에 공유
    return result;
  }

  async close() { await this.browser.close().catch(() => undefined); }
}
