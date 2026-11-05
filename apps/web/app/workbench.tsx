"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Download, EyeOff, FileSpreadsheet, HelpCircle, ListChecks, LoaderCircle, Play, Plus, Smartphone, Upload, X } from "lucide-react";
import { API, APP_PLATFORMS, fileToBase64, request } from "./api-client";

export type EnvSummary = {
  id: string;
  name: string;
  webUrl: string | null;
  isProduction: boolean;
  platform?: string;
  appConfig?: { appId?: string; deviceName?: string } | null;
  credentials?: Array<{ id: string; role: string; username: string }>;
};
export type SuiteSummary = {
  id: string;
  name: string;
  fileName: string;
  createdAt: string;
  meta: {
    sheets: Array<{ name: string; count: number; resultCodes?: { pass: string; fail: string; notTested: string; check: string } }>;
    skipped: string[];
    plan: { auto: number; manual: number; review: number };
    ai?: { status: string; refined?: number; error?: string };
    openQuestions?: Array<{ question: string; why: string; blocksTesting: boolean }>;
    source?: "sheet" | "designed";
  };
};
type ImportResult = { id: string; total: number; plan: { auto: number; manual: number; review: number }; skipped: string[]; sheets: Array<{ name: string; count: number }>; openQuestions?: Array<{ question: string; blocksTesting: boolean }> };
type SheetCase = {
  id: string;
  externalId: string | null;
  sheetName: string | null;
  rowNumber: number | null;
  enabled: boolean;
  metadata: { menuPath: string[]; item: string; stepsText?: string; plan: { mode: "AUTO" | "MANUAL"; reason?: string; checks: string[]; source?: string } } | null;
};

const PLATFORM_TEXT: Record<string, string> = { PC_WEB: "웹", RESPONSIVE_WEB: "반응형 웹", BACK_OFFICE: "관리자 웹", ANDROID: "Android 앱", IOS: "iOS 앱" };
export const envLabel = (e: EnvSummary) =>
  `${e.name} · ${PLATFORM_TEXT[e.platform ?? "PC_WEB"] ?? e.platform}${APP_PLATFORMS.has(e.platform ?? "") ? ` (${e.appConfig?.appId ?? "앱"})` : e.webUrl ? ` (${e.webUrl.replace(/^https?:\/\//, "")})` : ""}`;

const planKind = (c: SheetCase) => (c.metadata?.plan.mode === "MANUAL" ? "manual" : c.metadata?.plan.checks.length ? "auto" : "review");
/** "단계" 열의 [입력값] 들 (기법 기반 TC 에서 케이스마다 다른 입력을 보여 주기 위함) */
const inputsOf = (c: SheetCase) =>
  [...(c.metadata?.stepsText ?? "").matchAll(/\[([^\]]*)\]\s*$/gm)].map((m) => (m[1] === "" ? "(빈 값)" : m[1])).join(", ");
const KIND_TEXT = { auto: "자동 판정", review: "자동 이동 + 사람 확인", manual: "테스트불가(사람)" } as const;

/** QA 시나리오 시트: 업로드 → 실행 계획 확인 → 실행 */
export function SuitePanel(props: {
  projectId: string;
  suites: SuiteSummary[];
  environment?: EnvSummary;
  disabled: boolean;
  runTarget: string;
  onRunTarget: (suiteId: string) => void;
  onChanged: () => Promise<unknown>;
  onRun: (suiteId: string, sheets?: string[]) => void;
  onError: (message: string) => void;
}) {
  const { projectId, suites, environment, disabled } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [openSuite, setOpenSuite] = useState<string | null>(null);
  /** 시트별 실행 선택 (없으면 전체) */
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const pickedOf = (s: SuiteSummary) => picked[s.id] ?? s.meta.sheets.map((x) => x.name);
  const togglePick = (s: SuiteSummary, name: string) => {
    const cur = pickedOf(s);
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    setPicked({ ...picked, [s.id]: next });
  };

  /** .xlsx = 팀 QA 시트, .json = 기법 기반 TC(test-cases.json, 선택으로 test-model.json 함께) */
  const upload = async (files: File[]) => {
    setUploading(true);
    setNotice("");
    try {
      const xlsx = files.find((f) => /\.xlsx$/i.test(f.name));
      const jsons = files.filter((f) => /\.json$/i.test(f.name));
      let result: ImportResult;
      if (xlsx) {
        result = await request<ImportResult>(`/api/projects/${projectId}/suites`, {
          method: "POST",
          body: JSON.stringify({ fileName: xlsx.name, contentBase64: await fileToBase64(xlsx) }),
        });
      } else if (jsons.length) {
        let testCases: unknown[] | undefined;
        let testModel: Record<string, unknown> | undefined;
        for (const f of jsons) {
          let data: any;
          try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name}: JSON 형식이 아닙니다.`); }
          const payload = data?.result ?? data;
          if (Array.isArray(payload?.testCases)) testCases = payload.testCases;
          else if (Array.isArray(payload)) testCases = payload;
          else if (payload && (payload.businessRules || payload.openQuestions || payload.feature)) testModel = payload;
        }
        if (!testCases) throw new Error("test-cases.json (testCases 목록)이 필요합니다. test-model.json 은 함께 선택하면 열린 질문이 같이 들어갑니다.");
        result = await request<ImportResult>(`/api/projects/${projectId}/suites/designed`, {
          method: "POST",
          body: JSON.stringify({ testCases, testModel: testModel ? { feature: testModel.feature, openQuestions: testModel.openQuestions } : undefined }),
        });
      } else {
        throw new Error("엑셀(.xlsx) 시트나 기법 기반 TC(test-cases.json)를 올려 주세요.");
      }
      const blocking = (result.openQuestions ?? []).filter((q) => q.blocksTesting).length;
      setNotice(
        `${result.sheets.length}개 시트에서 ${result.total}건을 가져왔습니다 — 자동 판정 ${result.plan.auto} · 자동 이동+사람 확인 ${result.plan.review} · 테스트불가 ${result.plan.manual}` +
          (result.skipped.length ? ` (양식이 아니라 건너뛴 시트: ${result.skipped.join(", ")})` : "") +
          (result.openQuestions?.length ? ` · 열린 질문 ${result.openQuestions.length}건 (테스트를 막는 질문 ${blocking}건)` : ""),
      );
      await props.onChanged();
      props.onRunTarget(result.id);
      setOpenSuite(result.id);
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const hide = async (id: string) => {
    try {
      await request(`/api/suites/${id}`, { method: "DELETE" });
      if (props.runTarget === id) props.onRunTarget("");
      await props.onChanged();
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  return (
    <section className="panel suitePanel">
      <div className="suiteHead">
        <div>
          <h2>
            <FileSpreadsheet size={18} /> QA 시나리오 시트
          </h2>
          <p>
            팀에서 쓰는 테스트 시트(STEP ID · 메뉴 1~6Depth · 테스트 항목 · 결과)를 그대로 올리면, 메뉴 경로를 따라가며 항목을 확인하고 결과를 같은 양식에 채워 줍니다.
            기획서에서 ISTQB 기법으로 만든 TC(test-cases.json, test-model.json)를 올리면 같은 시트 양식으로 바꿔 실행합니다.
          </p>
        </div>
        <input ref={fileInput} type="file" accept=".xlsx,.json" multiple hidden onChange={(e) => e.target.files?.length && void upload(Array.from(e.target.files))} />
        <button className="secondary" disabled={disabled || uploading} onClick={() => fileInput.current?.click()} title="팀 QA 시트(.xlsx) 또는 기법 기반 TC(test-cases.json + test-model.json)">
          {uploading ? <LoaderCircle className="spin" /> : <Upload />} 시트·TC 올리기
        </button>
      </div>
      {notice && (
        <div className="noticeBar info" role="status">
          <span>
            <Check /> {notice}
          </span>
        </div>
      )}
      {!suites.length && <p className="suiteEmpty">아직 올린 시트가 없습니다.</p>}
      {suites.map((s) => {
        const total = s.meta.sheets.reduce((n, x) => n + x.count, 0);
        const selected = props.runTarget === s.id;
        return (
          <div className={`suiteRow${selected ? " selected" : ""}`} key={s.id}>
            <div className="suiteInfo">
              <strong>{s.name}</strong>
              <div className="sheetPicks" role="group" aria-label="실행할 시트">
                {s.meta.sheets.map((x) => (
                  <label key={x.name} className={pickedOf(s).includes(x.name) ? "chip active" : "chip"}>
                    <input type="checkbox" hidden checked={pickedOf(s).includes(x.name)} onChange={() => togglePick(s, x.name)} />
                    {x.name.trim()} {x.count}
                  </label>
                ))}
                <small>총 {total}건 · 선택한 시트만 실행</small>
              </div>
              <div className="planBars" aria-label="실행 방식 분포">
                <span className="auto" style={{ flex: s.meta.plan.auto }} title={`자동 판정 ${s.meta.plan.auto}`} />
                <span className="review" style={{ flex: s.meta.plan.review }} title={`자동 이동+사람 확인 ${s.meta.plan.review}`} />
                <span className="manual" style={{ flex: s.meta.plan.manual }} title={`테스트불가 ${s.meta.plan.manual}`} />
              </div>
              <small>
                자동 판정 {s.meta.plan.auto} · 자동 이동+사람 확인 {s.meta.plan.review} · 테스트불가 {s.meta.plan.manual}
                {s.meta.ai?.status === "RUNNING" && " · AI 보강 중…"}
                {s.meta.ai?.status === "COMPLETED" && ` · AI 보강 ${s.meta.ai.refined ?? 0}건`}
                {s.meta.source === "designed" && " · 기법 기반 TC에서 생성"}
              </small>
              <div className="suiteLinks">
                <a href={`${API}/api/suites/${s.id}/review.xlsx`} title="자동으로 판정하지 못하는 항목과 고쳐 쓰는 방법">
                  <Download size={13} /> 판정 개선 제안
                </a>
                <a href={`${API}/api/suites/${s.id}/original.xlsx`}>
                  <Download size={13} /> {s.meta.source === "designed" ? "생성된 QA 시트" : "원본 시트"}
                </a>
              </div>
              {!!s.meta.openQuestions?.length && (
                <details className="openQuestions">
                  <summary>
                    <HelpCircle size={13} /> 기획서가 답하지 않은 질문 {s.meta.openQuestions.length}건 (테스트를 막는 질문 {s.meta.openQuestions.filter((q) => q.blocksTesting).length}건) — 기획자에게 먼저 확인하세요
                  </summary>
                  <ol>
                    {[...s.meta.openQuestions].sort((a, b) => Number(b.blocksTesting) - Number(a.blocksTesting)).map((q, i) => (
                      <li key={i}>
                        {q.blocksTesting && <b className="blockTag">테스트 차단</b>} {q.question}
                        {q.why && <small>{q.why}</small>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
            <div className="suiteActions">
              <button className="secondary" onClick={() => setOpenSuite(openSuite === s.id ? null : s.id)}>
                <ListChecks /> 케이스
              </button>
              <button
                className="primary"
                disabled={disabled || !environment || !pickedOf(s).length}
                title={environment ? `${envLabel(environment)} 에서 실행` : "실행할 환경이 없습니다"}
                onClick={() => {
                  props.onRunTarget(s.id);
                  const sheets = pickedOf(s);
                  props.onRun(s.id, sheets.length === s.meta.sheets.length ? undefined : sheets);
                }}
              >
                <Play /> 이 시트로 실행
              </button>
              <button className="iconButton" title="목록에서 숨기기 (실행 이력은 보존)" disabled={disabled} onClick={() => void hide(s.id)}>
                <EyeOff size={16} />
              </button>
            </div>
            {openSuite === s.id && <SuiteCases projectId={projectId} suiteId={s.id} onError={props.onError} />}
          </div>
        );
      })}
    </section>
  );
}

function SuiteCases({ projectId, suiteId, onError }: { projectId: string; suiteId: string; onError: (m: string) => void }) {
  const [cases, setCases] = useState<SheetCase[] | null>(null);
  const [filter, setFilter] = useState<"all" | "auto" | "review" | "manual">("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(60);

  useEffect(() => {
    void request<SheetCase[]>(`/api/projects/${projectId}/test-cases?suiteId=${suiteId}&all=true`)
      .then(setCases)
      .catch((e) => onError((e as Error).message));
  }, [projectId, suiteId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cases ?? []).filter(
      (c) =>
        (filter === "all" || planKind(c) === filter) &&
        (!q || `${c.externalId} ${c.sheetName} ${c.metadata?.menuPath.join(" ")} ${c.metadata?.item}`.toLowerCase().includes(q)),
    );
  }, [cases, filter, query]);

  const toggle = async (c: SheetCase) => {
    try {
      const next = await request<{ enabled: boolean }>(`/api/test-cases/${c.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !c.enabled }) });
      setCases((list) => (list ?? []).map((x) => (x.id === c.id ? { ...x, enabled: next.enabled } : x)));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  if (!cases) return <p className="suiteEmpty"><LoaderCircle className="spin" size={14} /> 불러오는 중…</p>;
  return (
    <div className="caseBrowser">
      <div className="caseFilters">
        {(["all", "auto", "review", "manual"] as const).map((k) => (
          <button key={k} className={filter === k ? "chip active" : "chip"} onClick={() => setFilter(k)}>
            {k === "all" ? `전체 ${cases.length}` : `${KIND_TEXT[k]} ${cases.filter((c) => planKind(c) === k).length}`}
          </button>
        ))}
        <input placeholder="STEP ID·메뉴·항목 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="caseTable">
        <div className="caseHead">
          <span>실행</span>
          <span>STEP ID</span>
          <span>메뉴 경로 · 테스트 항목</span>
          <span>실행 방식</span>
        </div>
        {visible.slice(0, limit).map((c) => {
          const kind = planKind(c);
          return (
            <div className={`caseRow${c.enabled ? "" : " off"}`} key={c.id}>
              <span>
                <input type="checkbox" checked={c.enabled} onChange={() => void toggle(c)} aria-label="실행 포함" />
              </span>
              <span className="mono">
                {c.externalId}
                <small>{c.sheetName?.trim()}</small>
              </span>
              <span>
                <small>{c.metadata?.menuPath.join(" › ")}</small>
                {c.metadata?.item}
                {inputsOf(c) && <small className="inputs">입력: {inputsOf(c)}</small>}
              </span>
              <span className={`kind ${kind}`}>
                {KIND_TEXT[kind]}
                <small>{kind === "manual" ? c.metadata?.plan.reason : kind === "auto" ? c.metadata?.plan.checks.join(" / ") : "메뉴 이동 후 화면 캡처"}</small>
              </span>
            </div>
          );
        })}
      </div>
      {visible.length > limit && (
        <button className="secondary more" onClick={() => setLimit(limit + 100)}>
          더 보기 ({visible.length - limit}건 남음) <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}

/** 환경 추가 (웹 / Android 앱 / iOS 앱) */
export function AddEnvironment({ projectId, onAdded, onError }: { projectId: string; onAdded: (id: string) => Promise<unknown>; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appStatus, setAppStatus] = useState<{ ok: boolean; message: string; appiumUrl: string } | null>(null);
  const [f, setF] = useState({ name: "", platform: "ANDROID", webUrl: "", appId: "", deviceName: "", appActivity: "", app: "", isProduction: false, role: "", username: "", password: "" });
  const isApp = APP_PLATFORMS.has(f.platform);

  useEffect(() => {
    if (!open || !isApp) return;
    void request<{ ok: boolean; message: string; appiumUrl: string }>("/api/app/status").then(setAppStatus).catch(() => setAppStatus(null));
  }, [open, isApp]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const env = await request<{ id: string }>(`/api/projects/${projectId}/environments`, {
        method: "POST",
        body: JSON.stringify({
          name: f.name || (isApp ? `${f.platform === "IOS" ? "iOS" : "Android"} 앱` : "웹"),
          platform: f.platform,
          webUrl: isApp ? undefined : f.webUrl,
          isProduction: f.isProduction,
          appConfig: isApp
            ? { appId: f.appId || undefined, deviceName: f.deviceName || undefined, appActivity: f.appActivity || undefined, app: f.app || undefined }
            : undefined,
        }),
      });
      if (f.username && f.password) {
        await request(`/api/environments/${env.id}/credentials`, {
          method: "POST",
          body: JSON.stringify({ role: f.role || "사용자", username: f.username, password: f.password }),
        });
      }
      await onAdded(env.id);
      setOpen(false);
      setF({ ...f, name: "", webUrl: "", appId: "", deviceName: "", appActivity: "", app: "", username: "", password: "" });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        <Plus /> 환경 추가
      </button>
    );
  return (
    <div className="guideModalOverlay" onClick={() => setOpen(false)}>
      <form className="panel formPanel envModal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="panelTitle">
          <span>ENV</span>
          <div>
            <h1>테스트 환경 추가</h1>
            <p>같은 시나리오 시트를 웹과 앱 환경에서 각각 실행할 수 있습니다.</p>
          </div>
          <button type="button" className="iconButton" onClick={() => setOpen(false)} aria-label="닫기">
            <X size={16} />
          </button>
        </div>
        <fieldset>
          <legend>대상</legend>
          <div className="choiceGrid">
            {(["PC_WEB", "ANDROID", "IOS"] as const).map((p) => (
              <label key={p} className={f.platform === p ? "choice selected" : "choice"}>
                <input type="radio" name="platform" checked={f.platform === p} onChange={() => setF({ ...f, platform: p })} />
                <span>
                  <Check size={15} />
                </span>
                {PLATFORM_TEXT[p]}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          환경 이름
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={isApp ? "예: 갤럭시 S22 / QA 빌드" : "예: 스테이징"} />
        </label>
        {isApp ? (
          <>
            <div className="twoCols">
              <label>
                앱 ID ({f.platform === "IOS" ? "번들 ID" : "패키지명"})
                <input required={!f.app} value={f.appId} onChange={(e) => setF({ ...f, appId: e.target.value })} placeholder={f.platform === "IOS" ? "com.company.app" : "com.company.app"} />
              </label>
              <label>
                기기 이름 (선택)
                <input value={f.deviceName} onChange={(e) => setF({ ...f, deviceName: e.target.value })} placeholder="emulator-5554 / 기기 이름" />
              </label>
            </div>
            {f.platform === "ANDROID" && (
              <label>
                시작 화면 Activity (선택)
                <input value={f.appActivity} onChange={(e) => setF({ ...f, appActivity: e.target.value })} placeholder=".MainActivity" />
              </label>
            )}
            <label>
              설치 파일 경로 (선택, 서버 PC 기준 .apk/.app/.ipa)
              <input value={f.app} onChange={(e) => setF({ ...f, app: e.target.value })} placeholder="C:\builds\app-qa.apk" />
            </label>
            <div className={`noticeBar ${appStatus?.ok ? "info" : "error"}`}>
              <span>
                <Smartphone />
                {appStatus
                  ? appStatus.ok
                    ? `앱 실행기(Appium) 연결됨: ${appStatus.appiumUrl}`
                    : `앱 실행기(Appium)에 연결되지 않았습니다 (${appStatus.appiumUrl}). 환경은 지금 등록해 두고, 실행 전에 Appium 서버와 기기(에뮬레이터)를 켜 주세요. README 의 "앱 테스트 준비" 참고.`
                  : "앱 실행기 상태 확인 중…"}
              </span>
            </div>
          </>
        ) : (
          <label>
            테스트 URL
            <input required type="url" value={f.webUrl} onChange={(e) => setF({ ...f, webUrl: e.target.value })} placeholder="https://qa.example.com" />
          </label>
        )}
          <div className="twoCols">
            <label>
              권한 역할 (선택)
              <input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="일반 사용자" />
            </label>
            <label>
              계정 (선택)
              <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" />
            </label>
          </div>
          <label>
            비밀번호 (선택)
            <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          </label>
        <p className="hint">
          {isApp
            ? "계정을 넣으면 앱이 로그인 화면으로 시작할 때 자동으로 로그인합니다. 비워 두면 기기에 미리 로그인된 상태로 실행합니다."
            : "계정을 넣으면 실행 전에 자동으로 로그인합니다. 테스트 전용 계정을 사용하세요."}
        </p>
        <label className="production">
          <input type="checkbox" checked={f.isProduction} onChange={(e) => setF({ ...f, isProduction: e.target.checked })} />
          <span>
            <AlertTriangle /> 운영 환경으로 등록 <small>삭제·결제 같은 위험 동작을 자동으로 막습니다.</small>
          </span>
        </label>
        <button className="primary submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" /> : <Plus />} 환경 추가
        </button>
      </form>
    </div>
  );
}

// ── 실행 결과 화면: 필터·검색·스크린샷·사람 판정 ──────────────────────────────

type ResultRow = {
  id: string;
  result: string;
  manualResult: string | null;
  manualNote: string | null;
  reviewedAt: string | null;
  actual: string | null;
  durationMs: number | null;
  testCase: { id: string; title: string; externalId: string | null; sheetName: string | null; strategy: string; menuPath: string[]; item: string | null };
  screenshots: { id: string; name: string }[];
};
type ResultPage = { total: number; counts: Record<string, number>; items: ResultRow[] };

const RESULT_TEXT: Record<string, string> = {
  PASS: "통과(O)",
  FAIL: "실패(F)",
  SKIP: "테스트불가(NT)",
  BLOCKED: "차단(NT)",
  REQUIREMENT_CHECK: "재확인",
  FLAKY: "불안정(재시도 통과)",
};
const FILTERS: Array<[string, string]> = [
  ["NEEDS_REVIEW", "확인 필요"],
  ["ALL", "전체"],
  ["FAIL", "실패"],
  ["REQUIREMENT_CHECK", "재확인"],
  ["FLAKY", "불안정"],
  ["SKIP", "테스트불가"],
  ["PASS", "통과"],
];
const PAGE = 30;

/** 실행이 끝난 뒤 결과를 하나씩 확인하고, 사람이 O/F/NT 로 확정하는 화면 */
export function RunResults({ runId, onChanged, onError }: { runId: string; onChanged?: () => void; onError: (m: string) => void }) {
  const [status, setStatus] = useState("NEEDS_REVIEW");
  const [q, setQ] = useState("");
  const [skip, setSkip] = useState(0);
  const [data, setData] = useState<ResultPage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      const params = new URLSearchParams({ status, q, skip: String(skip), take: String(PAGE) });
      try {
        setData(await request<ResultPage>(`/api/runs/${runId}/results?${params}`));
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [runId, status, q, skip, onError],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  // 확인할 항목이 없으면 전체 보기로
  const autoSwitched = useRef(false);
  useEffect(() => {
    if (!autoSwitched.current && data && status === "NEEDS_REVIEW" && !q && data.total === 0 && (data.counts.ALL ?? 0) > 0) {
      autoSwitched.current = true;
      setStatus("ALL");
    }
  }, [data, status, q]);

  const decide = async (row: ResultRow, manualResult: string | null) => {
    setSaving(row.id);
    try {
      await request(`/api/results/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ manualResult, manualNote: notes[row.id] ?? row.manualNote ?? undefined }),
      });
      await load();
      onChanged?.();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const counts = data?.counts ?? {};
  return (
    <div className="runResults">
      <div className="runResultsHead">
        <div className="chipRow">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={status === key ? "chip active" : "chip"}
              onClick={() => {
                setStatus(key);
                setSkip(0);
              }}
            >
              {label} <b>{counts[key] ?? 0}</b>
            </button>
          ))}
        </div>
        <input
          className="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSkip(0);
          }}
          placeholder="ID·시트·항목·사유 검색"
        />
      </div>
      {data && data.items.length === 0 && <p className="hint">해당하는 결과가 없습니다.</p>}
      <div className="resultList">
        {data?.items.map((row) => {
          const final = row.manualResult ?? row.result;
          const expanded = open === row.id;
          return (
            <div key={row.id} className={`resultItem ${expanded ? "open" : ""}`}>
              <button type="button" className="resultItemHead" onClick={() => setOpen(expanded ? null : row.id)}>
                <ChevronRight className="caret" />
                <span className="resultMain">
                  <span className="resultTitle">
                    {row.testCase.externalId && !row.testCase.title.startsWith(row.testCase.externalId) && <b className="mono">{row.testCase.externalId} </b>}
                    {row.testCase.title}
                  </span>
                  {row.testCase.menuPath.length > 0 && <small>{row.testCase.menuPath.join(" › ")}</small>}
                </span>
                {row.manualResult && <span className="tag">사람 확인</span>}
                <span className={`result ${final.toLowerCase()}`}>{RESULT_TEXT[final] ?? final}</span>
              </button>
              {expanded && (
                <div className="resultBody">
                  {row.testCase.item && (
                    <p>
                      <b>테스트 항목</b> {row.testCase.item}
                    </p>
                  )}
                  <p>
                    <b>자동 판정</b> {RESULT_TEXT[row.result] ?? row.result}
                    {row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(1)}초` : ""}
                  </p>
                  {row.actual && <pre className="actual">{row.actual}</pre>}
                  {row.screenshots.length > 0 && (
                    <div className="shots">
                      {row.screenshots.map((s) => (
                        <button type="button" key={s.id} onClick={() => setZoom(s.id)} title={s.name}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`${API}/api/artifacts/${s.id}/file`} alt={s.name} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="decide">
                    <input
                      value={notes[row.id] ?? row.manualNote ?? ""}
                      onChange={(e) => setNotes({ ...notes, [row.id]: e.target.value })}
                      placeholder="확인 메모 (원본 시트 이슈 칸에 [확인] 으로 기록)"
                      maxLength={2000}
                    />
                    {(["PASS", "FAIL", "SKIP"] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={`judge ${r.toLowerCase()} ${row.manualResult === r ? "selected" : ""}`}
                        disabled={saving === row.id}
                        onClick={() => void decide(row, r)}
                      >
                        {r === "PASS" ? "O 통과" : r === "FAIL" ? "F 실패" : "NT 불가"}
                      </button>
                    ))}
                    {row.manualResult && (
                      <button type="button" className="judge reset" disabled={saving === row.id} onClick={() => void decide(row, null)}>
                        자동 판정으로
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {data && data.total > PAGE && (
        <div className="pager">
          <button type="button" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>
            이전
          </button>
          <span>
            {skip + 1}–{Math.min(skip + PAGE, data.total)} / {data.total}
          </span>
          <button type="button" disabled={skip + PAGE >= data.total} onClick={() => setSkip(skip + PAGE)}>
            다음
          </button>
        </div>
      )}
      {zoom && (
        <div className="guideModalOverlay" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="zoomShot" src={`${API}/api/artifacts/${zoom}/file`} alt="화면 캡처" />
        </div>
      )}
    </div>
  );
}
