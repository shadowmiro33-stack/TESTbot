"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Gauge,
  Globe2,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { API, APP_PLATFORMS, AUTH_EVENT, request } from "./api-client";
import { AddEnvironment, RunResults, SuitePanel, envLabel, type SuiteSummary } from "./workbench";

type Project = {
  id: string;
  name: string;
  platforms: string[];
  environments: Environment[];
  runs: Run[];
  suites?: SuiteSummary[];
  _count: { features: number; testCases: number };
};
type Environment = {
  id: string;
  name: string;
  webUrl: string | null;
  isProduction: boolean;
  platform?: string;
  appConfig?: { appId?: string; deviceName?: string } | null;
  credentials?: Array<{ id: string; role: string; username: string }>;
  analysisJobs?: AnalysisJob[];
};
type AnalysisJob = {
  id: string;
  status: string;
  summary?: Analysis | null;
  error?: string | null;
};
type Health = { status: string; queue: "redis" | "in-process"; workers: number; authRequired?: boolean };
type Result = {
  id: string;
  result: string;
  manualResult?: string | null;
  manualNote?: string | null;
  actual?: string;
  testCase: {
    id: string;
    title: string;
    strategy: string;
    severity: string;
    sourceType?: string;
    externalId?: string | null;
    sheetName?: string | null;
  };
};
type Run = {
  id: string;
  status: string;
  mode: string;
  error?: string | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results: Result[];
  project?: Project;
  environment?: Environment;
  suite?: { id: string; name: string; fileName: string } | null;
};
type Analysis = {
  pages: number;
  forms: number;
  inputs: number;
  buttons: number;
  apis: number;
  generated?: number;
};
const platformLabels: Record<string, string> = {
  BACK_OFFICE: "Back Office",
  PC_WEB: "PC Web",
  RESPONSIVE_WEB: "Responsive",
  ANDROID: "Android",
  IOS: "iOS",
};
const strategies = ["NORMAL", "EXCEPTION", "BOUNDARY"] as const;

function statusLabel(status: string) {
  return (
    (
      {
        QUEUED: "대기 중",
        RUNNING: "실행 중",
        COMPLETED: "완료",
        FAILED: "실패",
        CANCELLED: "취소됨",
      } as Record<string, string>
    )[status] ?? status
  );
}

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [view, setView] = useState<"list" | "new" | "project">("list");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const analyzing = !!analysisJob && ["QUEUED", "RUNNING"].includes(analysisJob.status);
  const [run, setRun] = useState<Run | null>(null);
  const runActive = !!run && ["QUEUED", "RUNNING"].includes(run.status);
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [selectedEnvId, setSelectedEnvId] = useState("");
  /** 실행 대상: "" = 자동 생성 TC, 그 외 = QA 시나리오 시트 ID */
  const [runTarget, setRunTarget] = useState("");
  const [showGuide, setShowGuide] = useState(false);
  const [guideTab, setGuideTab] = useState<"flow" | "sheet" | "modes" | "security" | "cli">("flow");
  const [form, setForm] = useState({
    name: "",
    url: "",
    username: "",
    password: "",
    role: "관리자",
    platforms: ["BACK_OFFICE", "PC_WEB", "RESPONSIVE_WEB"],
    production: false,
    mode: "SMOKE",
    target: "WEB" as "WEB" | "ANDROID" | "IOS",
    appId: "",
  });
  const currentEnv = selected?.environments.find((e) => e.id === selectedEnvId) ?? selected?.environments[0];
  const currentEnvIsApp = APP_PLATFORMS.has(currentEnv?.platform ?? "");
  const runSuite = selected?.suites?.find((s) => s.id === runTarget);
  const loadProjects = async () => {
    try {
      setProjects(await request("/api/projects"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadProject = async (id: string) => {
    const project = await request<Project>(`/api/projects/${id}`);
    setSelected(project);
    const latestJob = project.environments?.find((e) => !APP_PLATFORMS.has(e.platform ?? ""))?.analysisJobs?.[0];
    if (latestJob) {
      setAnalysisJob(latestJob);
      if (latestJob.status === "COMPLETED" && latestJob.summary) setAnalysis(latestJob.summary);
    }
    const latest = project.runs?.[0];
    if (latest) setRun(await request<Run>(`/api/runs/${latest.id}`));
    return project;
  };
  useEffect(() => {
    // 인증이 필요한 서버면 세션부터 확인 → 미인증이면 로그인 화면
    void request<{ authRequired: boolean; authenticated: boolean }>("/api/auth/session")
      .then((s) => (s.authRequired && !s.authenticated ? setNeedLogin(true) : loadProjects()))
      .catch(() => loadProjects());
    const onAuthRequired = () => setNeedLogin(true);
    window.addEventListener(AUTH_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_EVENT, onAuthRequired);
  }, []);
  useEffect(() => {
    const check = () =>
      void request<Health>("/health")
        .then(setHealth)
        .catch(() => setHealth(null));
    check();
    const timer = setInterval(check, 15000);
    return () => clearInterval(timer);
  }, []);
  // 분석은 백그라운드 작업 → 완료될 때까지 상태를 폴링
  useEffect(() => {
    if (!analysisJob || !["QUEUED", "RUNNING"].includes(analysisJob.status)) return;
    const projectId = selected?.id;
    const timer = setInterval(() => {
      void request<AnalysisJob>(`/api/analysis-jobs/${analysisJob.id}`)
        .then(async (next) => {
          setAnalysisJob(next);
          if (next.status === "COMPLETED") {
            if (next.summary) setAnalysis(next.summary);
            if (projectId) await loadProject(projectId);
            await loadProjects();
          } else if (next.status === "FAILED") {
            setError(`분석 실패: ${next.error ?? "알 수 없는 오류"}`);
          }
        })
        .catch((e) => setError((e as Error).message));
    }, 1500);
    return () => clearInterval(timer);
  }, [analysisJob?.id, analysisJob?.status]);
  useEffect(() => {
    if (!run || !["QUEUED", "RUNNING"].includes(run.status)) return;
    const timer = setInterval(
      () =>
        void request<Run>(`/api/runs/${run.id}`)
          .then((next) => {
            setRun(next);
            if (!["QUEUED", "RUNNING"].includes(next.status)) void loadProjects();
          })
          .catch((e) => setError((e as Error).message)),
      1800,
    );
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("create");
    setError("");
    try {
      const project = await request<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: form.name, platforms: form.target === "WEB" ? form.platforms : [form.target] }),
      });
      const isAppTarget = form.target !== "WEB";
      const env = await request<Environment>(
        `/api/projects/${project.id}/environments`,
        {
          method: "POST",
          body: JSON.stringify(
            isAppTarget
              ? { name: form.target === "IOS" ? "iOS 앱" : "Android 앱", platform: form.target, isProduction: form.production, appConfig: { appId: form.appId } }
              : { name: "QA 환경", webUrl: form.url, isProduction: form.production },
          ),
        },
      );
      if (!isAppTarget && form.username && form.password) {
        await request(`/api/environments/${env.id}/credentials`, {
          method: "POST",
          body: JSON.stringify({
            role: form.role,
            username: form.username,
            password: form.password,
          }),
        });
      }
      await loadProjects();
      const full = await loadProject(project.id);
      setSelected(full);
      setView("project");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const analyze = async () => {
    if (!currentEnv) return;
    setBusy("analyze");
    setError("");
    try {
      const job = await request<AnalysisJob>(
        `/api/environments/${currentEnv.id}/analyze`,
        { method: "POST", body: JSON.stringify({ strategies, replace: true }) },
      );
      setAnalysisJob(job);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const cancelRun = async () => {
    if (!run) return;
    setError("");
    try {
      setRun({ ...run, ...(await request<Run>(`/api/runs/${run.id}/cancel`, { method: "POST" })) });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const startRun = async (retest = false, suiteOverride?: string, sheets?: string[]) => {
    if (!selected || !currentEnv) return;
    const suiteId = suiteOverride ?? runTarget;
    setBusy("run");
    setError("");
    try {
      const next =
        retest && run
          ? await request<Run>(`/api/runs/${run.id}/retest-fails`, {
              method: "POST",
            })
          : await request<Run>(`/api/projects/${selected.id}/runs`, {
              method: "POST",
              body: JSON.stringify({
                environmentId: currentEnv.id,
                credentialId: selectedCredentialId || undefined,
                suiteId: suiteId || undefined,
                sheets: suiteId ? sheets : undefined,
                mode: form.mode,
              }),
            });
      setRun(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const counts = useMemo<Record<string, number>>(
    () =>
      Object.fromEntries(
        ["PASS", "FAIL", "BLOCKED", "REQUIREMENT_CHECK", "SKIP", "FLAKY"].map((s) => [
          s,
          // 사람이 확정한 판정이 있으면 그것을 기준으로 집계
          run?.results?.filter((r) => (r.manualResult ?? r.result) === s).length ?? 0,
        ]),
      ),
    [run],
  );
  const total = run?.results?.length ?? 0;
  // REQUIREMENT_CHECK(정책 확인 필요)는 합격/불합격 판정 대상이 아니므로 분모에서 제외
  const judged = total - (counts.REQUIREMENT_CHECK ?? 0) - (counts.SKIP ?? 0) - (counts.FLAKY ?? 0);
  const passRate = judged > 0 ? Math.round(((counts.PASS ?? 0) / judged) * 1000) / 10 : 0;
  const runSuiteTotal = run?.suite ? selected?.suites?.find((s) => s.id === run.suite?.id)?.meta?.sheets?.reduce((n, x) => n + x.count, 0) : undefined;
  const expectedCases = runSuiteTotal ?? selected?._count.testCases ?? 0;
  const openProject = async (project: Project) => {
    setSelected(project);
    setSelectedCredentialId("");
    setSelectedEnvId("");
    setRunTarget("");
    setView("project");
    setAnalysis(null);
    setAnalysisJob(null);
    setRun(null);
    setError("");
    await loadProject(project.id).catch((e) => setError(e.message));
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError("");
    setBusy("login");
    try {
      await request("/api/auth/login", { method: "POST", body: JSON.stringify({ token: loginToken }) });
      setNeedLogin(false);
      setLoginToken("");
      setError("");
      await loadProjects();
    } catch (e) {
      setLoginError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const logout = async () => {
    await request("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setProjects([]);
    setSelected(null);
    setRun(null);
    setView("list");
    setNeedLogin(true);
  };

  if (needLogin) {
    return (
      <main className="loginScreen">
        <form className="panel loginCard" onSubmit={login}>
          <div className="brand">
            <span className="mark">AH</span>
            <span>
              AUTOHANDS<small>AI QA SYSTEM</small>
            </span>
          </div>
          <h1>로그인</h1>
          <p>관리자에게 받은 접근 토큰을 입력하세요.</p>
          <label>
            접근 토큰
            <input
              type="password"
              name="token"
              autoComplete="current-password"
              required
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
            />
          </label>
          {loginError && (
            <div className="noticeBar error" role="alert">
              <AlertTriangle /> <span>{loginError}</span>
            </div>
          )}
          <button className="primary" type="submit" disabled={busy === "login"}>
            {busy === "login" ? <LoaderCircle className="spin" /> : <ShieldCheck />} 로그인
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">AH</span>
          <span>
            AUTOHANDS<small>AI QA SYSTEM</small>
          </span>
        </div>
        <nav>
          <button className={view === "list" ? "navActive" : ""} onClick={() => setView("list")}>
            <Layers3 size={18} /> 프로젝트
          </button>
          <button onClick={() => setShowGuide(true)}>
            <BookOpen size={18} /> 사용 가이드
          </button>
          <button onClick={() => { setShowGuide(true); setGuideTab("security"); }}>
            <ShieldCheck size={18} /> 안전 정책
          </button>
          {health?.authRequired && (
            <button onClick={() => void logout()}>
              <ArrowLeft size={18} /> 로그아웃
            </button>
          )}
        </nav>
        <div className="sideFoot">
          <span className="pulse" style={health ? undefined : { background: "#ef4444" }} />{" "}
          {health ? "시스템 준비됨" : "API 연결 안 됨"}
          <small>
            {health
              ? health.queue === "redis"
                ? `분산 워커 ${health.workers}대${health.workers ? "" : " (API에서 직접 실행)"}`
                : "단독 실행 모드"
              : "API 서버 확인 필요"}
          </small>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">QA CONTROL CENTER</span>
            <strong>
              {view === "new"
                ? "새 테스트 등록"
                : view === "project"
                  ? selected?.name
                  : "프로젝트"}
            </strong>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              style={{
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                borderRadius: 8,
                padding: "6px 12px",
                fontSize: 13,
                fontWeight: 600,
                color: "#1e293b",
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <BookOpen size={15} color="#475569" /> 사용 가이드
            </button>
            <div className="environment">
              <span /> LOCAL MVP
            </div>
          </div>
        </header>
        {error && (
          <div className="errorBanner">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button aria-label="닫기" onClick={() => setError("")}>
              <X size={17} />
            </button>
          </div>
        )}
        <div className="content">
          {view === "list" && (
            <>
              <div className="pageHeading">
                <div>
                  <h1>테스트 프로젝트</h1>
                  <p>
                    서비스를 등록하고 AI 분석부터 리포트까지 한 흐름으로
                    실행하세요.
                  </p>
                </div>
                <button className="primary" onClick={() => setView("new")}>
                  <Plus size={18} /> 새 테스트
                </button>
              </div>
              <div className="overview">
                <div>
                  <Gauge />
                  <span>
                    전체 프로젝트<strong>{projects.length}</strong>
                  </span>
                </div>
                <div>
                  <Check />
                  <span>
                    완료된 실행
                    <strong>
                      {
                        projects.filter(
                          (p) => p.runs?.[0]?.status === "COMPLETED",
                        ).length
                      }
                    </strong>
                  </span>
                </div>
                <div>
                  <Search />
                  <span>
                    발견 기능
                    <strong>
                      {projects.reduce((n, p) => n + p._count.features, 0)}
                    </strong>
                  </span>
                </div>
                <div>
                  <Sparkles />
                  <span>
                    생성된 TC
                    <strong>
                      {projects.reduce((n, p) => n + p._count.testCases, 0)}
                    </strong>
                  </span>
                </div>
              </div>
              <div className="projectGrid">
                {projects.map((p) => {
                  const latest = p.runs?.[0];
                  const latestResults = latest?.results ?? [];
                  const resultTotal = latestResults.length;
                  const rate = resultTotal
                    ? Math.round(
                        (latestResults.filter((r) => r.result === "PASS")
                          .length /
                          resultTotal) *
                          100,
                      )
                    : 0;
                  return (
                    <button
                      className="projectCard"
                      key={p.id}
                      onClick={() => void openProject(p)}
                    >
                      <div className="projectTop">
                        <span className="projectIcon">
                          <Globe2 />
                        </span>
                        <span
                          className={`status ${latest?.status?.toLowerCase() ?? "ready"}`}
                        >
                          {latest ? statusLabel(latest.status) : "준비"}
                        </span>
                      </div>
                      <h2>{p.name}</h2>
                      <p>{p.environments[0] ? envLabel(p.environments[0]) : "환경 미등록"}</p>
                      <div className="chips">
                        {p.platforms.map((x) => (
                          <span key={x}>{platformLabels[x]}</span>
                        ))}
                      </div>
                      <div className="projectStats">
                        <span>
                          기능 <b>{p._count.features}</b>
                        </span>
                        <span>
                          TC <b>{p._count.testCases}</b>
                        </span>
                        <span>
                          PASS <b>{rate}%</b>
                        </span>
                        <ChevronRight />
                      </div>
                    </button>
                  );
                })}
                {!projects.length && (
                  <div className="empty">
                    <span>
                      <Search size={28} />
                    </span>
                    <h2>첫 테스트를 시작하세요</h2>
                    <p>
                      대상 URL과 계정을 등록하면 서비스 구조를 자동으로
                      탐색합니다.
                    </p>
                    <button
                      className="secondary"
                      onClick={() => setView("new")}
                    >
                      <Plus size={17} /> 프로젝트 만들기
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {view === "new" && (
            <>
              <button className="back" onClick={() => setView("list")}>
                <ArrowLeft size={17} /> 프로젝트 목록
              </button>
              <div className="formLayout">
                <form className="panel formPanel" onSubmit={createProject}>
                  <div className="panelTitle">
                    <span>01</span>
                    <div>
                      <h1>테스트 대상 등록</h1>
                      <p>
                        접속 정보는 암호화되어 저장되며 로그에 노출되지
                        않습니다.
                      </p>
                    </div>
                  </div>
                  <label>
                    서비스명
                    <input
                      required
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                      placeholder="예: 렌터카 CMS"
                    />
                  </label>
                  <fieldset>
                    <legend>테스트 대상</legend>
                    <div className="choiceGrid">
                      {([["WEB", "웹 서비스"], ["ANDROID", "Android 앱"], ["IOS", "iOS 앱"]] as const).map(([key, label]) => (
                        <label className={form.target === key ? "choice selected" : "choice"} key={key}>
                          <input type="radio" name="target" checked={form.target === key} onChange={() => setForm({ ...form, target: key })} />
                          <span>
                            <Check size={15} />
                          </span>
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {form.target !== "WEB" ? (
                    <label>
                      앱 ID ({form.target === "IOS" ? "번들 ID" : "패키지명"})
                      <input required value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} placeholder="com.company.app" />
                      <small style={{ fontWeight: 400, color: "var(--muted)" }}>
                        앱은 QA 시나리오 시트로 실행합니다. 등록 후 프로젝트 화면에서 시트를 올리세요. 웹 환경은 나중에 「환경 추가」로 함께 등록할 수 있습니다.
                      </small>
                    </label>
                  ) : (
                  <>
                  <fieldset>
                    <legend>플랫폼</legend>
                    <div className="choiceGrid">
                      {Object.entries(platformLabels)
                        .slice(0, 3)
                        .map(([key, label]) => (
                          <label
                            className={
                              form.platforms.includes(key)
                                ? "choice selected"
                                : "choice"
                            }
                            key={key}
                          >
                            <input
                              type="checkbox"
                              checked={form.platforms.includes(key)}
                              onChange={() =>
                                setForm({
                                  ...form,
                                  platforms: form.platforms.includes(key)
                                    ? form.platforms.filter((x) => x !== key)
                                    : [...form.platforms, key],
                                })
                              }
                            />
                            <span>
                              <Check size={15} />
                            </span>
                            {label}
                          </label>
                        ))}
                    </div>
                  </fieldset>
                  <label>
                    테스트 URL
                    <input
                      required
                      type="url"
                      value={form.url}
                      onChange={(e) =>
                        setForm({ ...form, url: e.target.value })
                      }
                      placeholder="https://qa.example.com"
                    />
                  </label>
                  <div className="twoCols">
                    <label>
                      권한 역할
                      <input
                        required
                        value={form.role}
                        onChange={(e) =>
                          setForm({ ...form, role: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      사용자 계정
                      <input
                        value={form.username}
                        onChange={(e) =>
                          setForm({ ...form, username: e.target.value })
                        }
                        placeholder="admin@example.com"
                      />
                    </label>
                  </div>
                  <label>
                    비밀번호
                    <input
                      type="password"
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                      placeholder="••••••••"
                    />
                  </label>
                  </>
                  )}
                  <label className="production">
                    <input
                      type="checkbox"
                      checked={form.production}
                      onChange={(e) =>
                        setForm({ ...form, production: e.target.checked })
                      }
                    />
                    <span>
                      <ShieldCheck />
                      운영 환경으로 등록{" "}
                      <small>위험 작업이 자동 차단됩니다.</small>
                    </span>
                  </label>
                  <button className="primary submit" disabled={!!busy}>
                    {busy === "create" ? (
                      <>
                        <LoaderCircle className="spin" /> 등록 중…
                      </>
                    ) : (
                      <>
                        프로젝트 등록 <ChevronRight />
                      </>
                    )}
                  </button>
                </form>
                <aside className="processPanel">
                  <span className="eyebrow">WHAT HAPPENS NEXT</span>
                  <h2>
                    등록 후 자동으로
                    <br />이 흐름을 시작합니다.
                  </h2>
                  {[
                    ["01", "로그인 탐지", "입력 필드와 인증 흐름 확인"],
                    ["02", "서비스 탐색", "페이지·폼·버튼·API 수집"],
                    ["03", "테스트 설계", "정상·예외·경계 TC 생성"],
                    ["04", "증빙 실행", "Screenshot·Log·Excel 생성"],
                  ].map(([n, t, d]) => (
                    <div className="process" key={n}>
                      <b>{n}</b>
                      <span>
                        <strong>{t}</strong>
                        <small>{d}</small>
                      </span>
                    </div>
                  ))}
                </aside>
              </div>
            </>
          )}
          {view === "project" && selected && (
            <>
              <button
                className="back"
                onClick={() => {
                  setView("list");
                  void loadProjects();
                }}
              >
                <ArrowLeft size={17} /> 프로젝트 목록
              </button>
              <div className="projectHeader">
                <div>
                  <div className="chips">
                    {selected.platforms.map((x) => (
                      <span key={x}>{platformLabels[x]}</span>
                    ))}
                  </div>
                  <h1>{selected.name}</h1>
                  <p>{currentEnv ? envLabel(currentEnv) : "환경 미등록"}</p>
                </div>
                <div className="headerActions">
                  {selected.environments.length > 1 && (
                    <select
                      value={currentEnv?.id ?? ""}
                      onChange={(e) => {
                        setSelectedEnvId(e.target.value);
                        setSelectedCredentialId("");
                      }}
                      title="실행 환경 선택"
                    >
                      {selected.environments.map((e) => (
                        <option key={e.id} value={e.id}>
                          환경: {envLabel(e)}
                        </option>
                      ))}
                    </select>
                  )}
                  <AddEnvironment
                    projectId={selected.id}
                    onError={setError}
                    onAdded={async (id) => {
                      await loadProject(selected.id);
                      setSelectedEnvId(id);
                    }}
                  />
                  <select value={runTarget} onChange={(e) => setRunTarget(e.target.value)} title="실행할 테스트 케이스">
                    <option value="">대상: 자동 생성 TC</option>
                    {(selected.suites ?? []).filter((s) => s.meta).map((s) => (
                      <option key={s.id} value={s.id}>
                        대상: 시트 {s.name}
                      </option>
                    ))}
                  </select>
                  {currentEnv?.credentials && currentEnv.credentials.length > 1 && (
                    <select
                      value={selectedCredentialId}
                      onChange={(e) => setSelectedCredentialId(e.target.value)}
                      title="실행 계정 선택"
                    >
                      <option value="">계정: 기본 ({currentEnv.credentials[0]?.role})</option>
                      {currentEnv.credentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.role} ({c.username})
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    value={form.mode}
                    onChange={(e) => setForm({ ...form, mode: e.target.value })}
                  >
                    <option>SMOKE</option>
                    <option>REGRESSION</option>
                    <option>FULL_MATRIX</option>
                  </select>
                  <button
                    className="secondary"
                    disabled={!!busy || analyzing || runActive || currentEnvIsApp}
                    title={currentEnvIsApp ? "앱 환경은 화면 자동 분석 대신 QA 시나리오 시트로 실행합니다." : runActive ? "테스트 실행 중에는 분석할 수 없습니다. 실행이 끝나거나 취소한 뒤 다시 시도하세요." : undefined}
                    onClick={() => void analyze()}
                  >
                    {busy === "analyze" || analyzing ? (
                      <LoaderCircle className="spin" />
                    ) : (
                      <Search />
                    )}{" "}
                    분석 및 TC 생성
                  </button>
                  <button
                    className="primary"
                    disabled={!!busy || analyzing || runActive || (runTarget ? false : !selected._count.testCases || currentEnvIsApp)}
                    title={!runTarget && currentEnvIsApp ? "앱 환경은 실행 대상을 QA 시나리오 시트로 선택하세요." : undefined}
                    onClick={() => void startRun()}
                  >
                    <Play /> {runSuite ? "시트 실행" : "테스트 실행"}
                  </button>
                </div>
              </div>
              {analyzing && (
                <div className="noticeBar info" role="status">
                  <span>
                    <LoaderCircle className="spin" />{" "}
                    {analysisJob?.status === "QUEUED"
                      ? "분석 대기 중입니다…"
                      : "서비스 구조를 분석하고 테스트 케이스를 생성하는 중입니다. 페이지 수에 따라 수 분이 걸릴 수 있습니다."}
                  </span>
                </div>
              )}
              <div className="metricRow">
                <div>
                  <span>발견 페이지</span>
                  <strong>{analysis?.pages ?? selected._count.features}</strong>
                  <small>DISCOVERED</small>
                </div>
                <div>
                  <span>발견 Form</span>
                  <strong>{analysis?.forms ?? "—"}</strong>
                  <small>STRUCTURE</small>
                </div>
                <div>
                  <span>발견 API</span>
                  <strong>{analysis?.apis ?? "—"}</strong>
                  <small>NETWORK</small>
                </div>
                <div>
                  <span>생성 테스트</span>
                  <strong>{selected._count.testCases}</strong>
                  <small>NORMAL · EXCEPTION · BOUNDARY</small>
                </div>
              </div>
              {run ? (
                <section className="panel runPanel">
                  <div className="runTitle">
                    <div>
                      <span className={`runDot ${run.status.toLowerCase()}`} />
                      <span>
                        <small>{run.mode}</small>
                        <h2>{statusLabel(run.status)}</h2>
                      </span>
                    </div>
                    <strong style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {run.status === "COMPLETED"
                        ? `${passRate}%`
                        : runActive
                          ? `${total}${run.mode !== "FAIL_RETEST" && expectedCases ? ` / ${expectedCases}` : ""} TC 처리`
                          : total > 0
                            ? `${total}건 처리 후 ${run.status === "CANCELLED" ? "중단" : "실패"}`
                            : ""}
                      {["QUEUED", "RUNNING"].includes(run.status) && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void cancelRun()}
                          style={{ fontSize: 13, padding: "4px 10px" }}
                        >
                          <X size={14} /> 취소
                        </button>
                      )}
                    </strong>
                  </div>
                  {run.status === "FAILED" && run.error && (
                    <div className="noticeBar error" role="alert">
                      <AlertTriangle /> <span>{run.error}</span>
                    </div>
                  )}
                  <div className="progress">
                    <span
                      style={{
                        width:
                          run.status === "COMPLETED"
                            ? "100%"
                            : `${Math.min(99, expectedCases ? (total / expectedCases) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                  <div className="resultGrid">
                    <div className="pass">
                      <Check />
                      <span>
                        PASS<strong>{counts.PASS}</strong>
                      </span>
                    </div>
                    <div className="fail">
                      <X />
                      <span>
                        FAIL<strong>{counts.FAIL}</strong>
                      </span>
                    </div>
                    <div className="blocked">
                      <ShieldCheck />
                      <span>
                        BLOCKED<strong>{counts.BLOCKED}</strong>
                      </span>
                    </div>
                    <div>
                      <AlertTriangle />
                      <span>
                        {run.suite ? "재확인" : "REQUIREMENT"}<strong>{counts.REQUIREMENT_CHECK}</strong>
                      </span>
                    </div>
                    {(counts.FLAKY ?? 0) > 0 && (
                      <div>
                        <RefreshCw />
                        <span>
                          불안정<strong>{counts.FLAKY}</strong>
                        </span>
                      </div>
                    )}
                    {(run.suite || (counts.SKIP ?? 0) > 0) && (
                      <div className="blocked">
                        <X />
                        <span>
                          테스트불가(NT)<strong>{counts.SKIP}</strong>
                        </span>
                      </div>
                    )}
                  </div>
                  {run.suite && (
                    <div className="noticeBar info">
                      <span>
                        <FileSpreadsheet /> 시트 「{run.suite.name}」 실행 — 재확인은 메뉴 경로를 화면에서 찾지 못했거나 자동 판정 근거가 부족한 항목(캡처 첨부), 테스트불가는 녹화·카메라·푸시처럼 사람이 해야 하는 항목입니다.
                      </span>
                    </div>
                  )}
                  {run.status === "COMPLETED" && run.results?.length > 0 && (
                    <RunResults runId={run.id} onError={setError} onChanged={() => void request<Run>(`/api/runs/${run.id}`).then(setRun).catch(() => undefined)} />
                  )}
                  {run.status !== "COMPLETED" && run.results?.length > 0 && (
                    <div className="resultTable">
                      <div className="tableHead">
                        <span>테스트 케이스</span>
                        <span>전략</span>
                        <span>심각도</span>
                        <span>결과</span>
                      </div>
                      {run.results
                        .slice(-8)
                        .reverse()
                        .map((r) => (
                          <div className="tableRow" key={r.id}>
                            <span>
                              {r.testCase.externalId && <b className="mono">[{r.testCase.sheetName?.trim()}] </b>}
                              {r.testCase.title}
                              {r.testCase.sourceType === "SUGGESTED" && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: "0.7rem",
                                    fontWeight: 600,
                                    padding: "1px 5px",
                                    borderRadius: 4,
                                    background: "rgba(139, 92, 246, 0.2)",
                                    color: "#c084fc",
                                    border: "1px solid rgba(139, 92, 246, 0.4)",
                                  }}
                                >
                                  AI
                                </span>
                              )}
                              <small>{r.actual}</small>
                            </span>
                            <span>{r.testCase.strategy}</span>
                            <span>{r.testCase.severity}</span>
                            <span
                              className={`result ${r.result.toLowerCase()}`}
                            >
                              {r.result === "SKIP" ? "NT" : r.result === "REQUIREMENT_CHECK" && run.suite ? "CHECK" : r.result}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}{" "}
                  {run.status === "COMPLETED" && (
                    <div className="downloadBar">
                      <span>
                        <FileSpreadsheet /> 실행 결과가 준비되었습니다.
                      </span>
                      <div>
                        {run.suite && (
                          <a href={`${API}/api/runs/${run.id}/sheet.xlsx`}>
                            <Download /> 원본 양식 결과
                          </a>
                        )}
                        <a href={`${API}/api/runs/${run.id}/report.xlsx`}>
                          <Download /> Excel
                        </a>
                        <a href={`${API}/api/runs/${run.id}/artifacts.zip`}>
                          <Download /> 전체 ZIP
                        </a>
                        {(counts.FAIL ?? 0) > 0 && (
                          <button onClick={() => void startRun(true)}>
                            <RefreshCw /> FAIL 재테스트
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              ) : (
                <section className="panel readyPanel">
                  <span>
                    <Play />
                  </span>
                  <h2>테스트 실행 준비 완료</h2>
                  <p>
                    {runSuite
                      ? `시트 「${runSuite.name}」로 실행할 준비가 되었습니다.`
                      : selected._count.testCases
                        ? `${selected._count.testCases}개의 테스트 케이스를 실행할 수 있습니다.`
                        : "분석으로 테스트 케이스를 만들거나, 아래에서 QA 시나리오 시트를 올리세요."}
                  </p>
                </section>
              )}
              <SuitePanel
                projectId={selected.id}
                // 프로젝트 목록 응답에는 시트 요약(meta)이 없어, 상세를 불러오기 전에는 그리지 않음
                suites={(selected.suites ?? []).filter((s) => s.meta)}
                environment={currentEnv}
                disabled={!!busy || analyzing || runActive}
                runTarget={runTarget}
                onRunTarget={setRunTarget}
                onChanged={() => loadProject(selected.id)}
                onRun={(suiteId, sheets) => void startRun(false, suiteId, sheets)}
                onError={setError}
              />
            </>
          )}
        </div>
      </section>

      {showGuide && (
        <div className="guideModalOverlay" onClick={() => setShowGuide(false)}>
          <div className="guideModal" onClick={(e) => e.stopPropagation()}>
            <div className="guideHeader">
              <h2>
                <BookOpen size={20} color="#159974" /> AUTOHANDS AI QA 시스템 가이드
              </h2>
              <button
                type="button"
                className="guideClose"
                onClick={() => setShowGuide(false)}
                title="닫기"
              >
                <X size={20} />
              </button>
            </div>
            <div className="guideTabs">
              <button
                type="button"
                className={guideTab === "flow" ? "active" : ""}
                onClick={() => setGuideTab("flow")}
              >
                사용 흐름
              </button>
              <button
                type="button"
                className={guideTab === "sheet" ? "active" : ""}
                onClick={() => setGuideTab("sheet")}
              >
                시트 작성 규칙
              </button>
              <button
                type="button"
                className={guideTab === "modes" ? "active" : ""}
                onClick={() => setGuideTab("modes")}
              >
                테스트 모드 & AI
              </button>
              <button
                type="button"
                className={guideTab === "security" ? "active" : ""}
                onClick={() => setGuideTab("security")}
              >
                보안 & 안전 가드
              </button>
              <button
                type="button"
                className={guideTab === "cli" ? "active" : ""}
                onClick={() => setGuideTab("cli")}
              >
                명령어 / FAQ
              </button>
            </div>
            <div className="guideBody">
              {guideTab === "flow" && (
                <div>
                  <div className="guideStep">
                    <span className="guideNum">1</span>
                    <div className="guideContent">
                      <h3>프로젝트와 테스트 환경 등록</h3>
                      <p>
                        <strong>[+ 새 테스트]</strong>로 서비스를 만들고, 상단 <strong>[환경 추가]</strong>에서 웹(URL) 또는 앱(Android 패키지명 / iOS 번들 ID)을 등록합니다. 테스트 전용 계정을 넣으면 실행 전에 자동으로 로그인합니다. 운영 서비스라면 '운영 환경'을 체크해 삭제·결제 같은 동작을 막으세요.
                      </p>
                    </div>
                  </div>
                  <div className="guideStep">
                    <span className="guideNum">2</span>
                    <div className="guideContent">
                      <h3>QA 시나리오 시트 올리기</h3>
                      <p>
                        팀에서 쓰는 엑셀 시트(STEP ID · 1~6Depth · 테스트 항목 · 결과 열)를 그대로 올립니다. 시트마다 케이스가 <strong>자동 실행 / 재확인 / 사람 확인(NT)</strong>으로 분류되어 보이고, ISTQB 기법 스킬로 만든 <code>test-cases.json</code>도 같은 방식으로 올릴 수 있습니다.
                      </p>
                    </div>
                  </div>
                  <div className="guideStep">
                    <span className="guideNum">3</span>
                    <div className="guideContent">
                      <h3>실행 대상 고르고 실행</h3>
                      <p>
                        상단에서 환경(웹·Android·iOS)과 <strong>대상: 시트</strong>를 고르고, 필요한 시트만 칩으로 선택해 <strong>[테스트 실행]</strong>을 누릅니다. 같은 시트를 웹과 앱에서 각각 실행할 수 있습니다. 화면에 없는 메뉴는 스크롤하며 찾고, 권한·공지 팝업은 자동으로 닫습니다.
                      </p>
                    </div>
                  </div>
                  <div className="guideStep">
                    <span className="guideNum">4</span>
                    <div className="guideContent">
                      <h3>결과 확인과 사람 판정</h3>
                      <p>
                        실행이 끝나면 <strong>확인 필요</strong> 목록(실패·재확인·불안정·테스트불가)부터 보입니다. 항목을 펼쳐 사유와 화면 캡처를 보고 <strong>O / F / NT</strong> 버튼으로 확정하세요. 확정한 판정과 메모는 집계와 원본 시트에 그대로 반영됩니다.
                      </p>
                    </div>
                  </div>
                  <div className="guideStep">
                    <span className="guideNum">5</span>
                    <div className="guideContent">
                      <h3>원본 양식으로 결과 받기</h3>
                      <p>
                        <strong>[원본 양식 결과]</strong>를 받으면 올린 엑셀의 결과·이슈현상·접수일 칸이 채워진 파일이 내려옵니다. 실패만 다시 돌리려면 <strong>[FAIL 재테스트]</strong>를 누르세요.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {guideTab === "sheet" && (
                <div className="guideRules">
                  <h3>시트를 이렇게 쓰면 자동 실행됩니다</h3>
                  <ul>
                    <li><strong>STEP (ID)</strong> 열이 있는 행이 헤더입니다. ID가 있는 행만 케이스로 읽고, ID 없는 행은 구역 제목으로 봅니다.</li>
                    <li><strong>1~6Depth</strong>는 화면에서 누를 메뉴 이름을 순서대로 적습니다. 위 행과 같으면 비워 두세요 (자동으로 채워 읽음).</li>
                    <li>메뉴 이름은 화면에 보이는 글자와 같게 씁니다. "버튼·탭·화면" 같은 말은 붙여도 됩니다. <code>[p]추천</code>처럼 쓰면 누르지 않고 "이 화면에 있음"만 확인합니다.</li>
                    <li><strong>테스트 항목</strong>에서 화면에 떠야 하는 문구는 큰따옴표로 씁니다. 예) <code>"저장되었습니다" 문구 노출</code> → 문구가 없으면 실패(F).</li>
                    <li>따옴표 없이 쓴 기대 결과는 추정 검증이라, 못 찾으면 실패 대신 <strong>재확인</strong>으로 남깁니다.</li>
                    <li>"0023 선행 작업 후"처럼 다른 케이스 ID를 쓰면 그 케이스의 경로를 먼저 실행합니다. "디바이스 이전 버튼"은 뒤로 가기로 처리합니다.</li>
                    <li>녹화·카메라·푸시 수신·결제·네트워크 끊기·동시 접속처럼 사람이 해야 하는 항목은 자동으로 <strong>테스트불가(NT)</strong>와 사유가 기록됩니다.</li>
                  </ul>
                  <h3>단계 열을 쓰는 경우 (선택)</h3>
                  <ul>
                    <li><strong>단계</strong> 열이 있으면 메뉴 경로 대신 단계대로 실행합니다. 한 줄에 한 동작: <code>1. 「마이페이지」 탭을 누른다</code></li>
                    <li>「 」 = 화면·버튼·입력 칸 이름, " " = 화면에 표시되는 문구. 입력값은 끝에 대괄호: <code>2. 「닉네임」 필드에 입력한다 [테스터01]</code></li>
                    <li><strong>사전조건</strong> 열의 로그인 외 조건은 자동으로 준비하지 못하므로, 그런 케이스는 실패 대신 재확인으로 판정합니다.</li>
                  </ul>
                  <h3>결과 표시</h3>
                  <p>범례에 정의한 코드(예: 정상동작 O, 실패 F, 테스트불가 NT, 재확인요청 check)를 그대로 사용하고, 없으면 O / F / NT / check로 씁니다. 재시도해서 통과한 항목은 "불안정"으로 따로 모아 check로 표시합니다.</p>
                </div>
              )}

              {guideTab === "modes" && (
                <div>
                  <h3 style={{ margin: "0 0 10px", color: "var(--navy)" }}>테스트 실행 모드 안내</h3>
                  <div className="guideBadgeBox">
                    <div className="guideBadgeCard">
                      <strong>SMOKE 모드 (기본)</strong>
                      <p>PC 대표 해상도(1440x900) 1개로 빠르게 주요 기능의 동작 상태를 전수 확인합니다.</p>
                    </div>
                    <div className="guideBadgeCard">
                      <strong>FULL_MATRIX 모드</strong>
                      <p>데스크톱, 태블릿, 모바일(1920x1080부터 360x800까지) 총 8개 반응형 뷰포트에서 전수 검증합니다.</p>
                    </div>
                    <div className="guideBadgeCard">
                      <strong>REGRESSION 모드</strong>
                      <p>시스템 배포 후 기존 기능의 결함 여부를 확인하는 종합 회귀 테스트 모드입니다.</p>
                    </div>
                    <div className="guideBadgeCard">
                      <strong>FAIL_RETEST 모드</strong>
                      <p>직전 테스트에서 실패(FAIL)한 케이스만 골라 원래 사용한 계정으로 다시 재검증합니다.</p>
                    </div>
                  </div>

                  <h3 style={{ margin: "20px 0 10px", color: "var(--navy)" }}>AI(LLM) 연동 안내</h3>
                  <p style={{ color: "#64748b", margin: 0 }}>
                    루트 <code>.env</code> 파일에 <code>OPENAI_API_KEY</code>를 입력하시면 규칙 엔진과 함께 OpenAI 모델이 실제 비즈니스 흐름을 분석하여 보라색 <strong>[AI]</strong> 배지가 붙은 정밀 시나리오를 자동 생성합니다.
                  </p>
                </div>
              )}

              {guideTab === "security" && (
                <div>
                  <h3 style={{ margin: "0 0 10px", color: "var(--navy)" }}>엔터프라이즈급 3중 보안 가드</h3>
                  <div className="guideStep">
                    <ShieldCheck size={28} color="#159974" style={{ flexShrink: 0 }} />
                    <div className="guideContent">
                      <h3>비밀번호 양방향 암호화 (AES-256-GCM)</h3>
                      <p>등록된 모든 계정의 비밀번호는 평문으로 저장되지 않으며, 암호화 키를 통한 복호화 인증 시에만 안전하게 사용됩니다.</p>
                    </div>
                  </div>
                  <div className="guideStep">
                    <AlertTriangle size={28} color="#f4b740" style={{ flexShrink: 0 }} />
                    <div className="guideContent">
                      <h3>운영 환경 위험 액션 자동 차단 (BLOCKED)</h3>
                      <p>
                        '운영 환경' 플래그가 설정된 환경에서는 <code>삭제, 탈퇴, 결제, 환불, delete, refund</code> 키워드가 포함된 위험 버튼 클릭이 Playwright 실행 단계에서 자동으로 원천 차단됩니다.
                      </p>
                    </div>
                  </div>
                  <div className="guideStep">
                    <Check size={28} color="#3b82f6" style={{ flexShrink: 0 }} />
                    <div className="guideContent">
                      <h3>민감 로그 자동 마스킹</h3>
                      <p>
                        네트워크 통신 패킷 및 브라우저 콘솔 로그의 <code>authorization, cookie, password, token, secret</code> 값은 자동으로 <code>***</code> 처리되어 보고서에 노출되지 않습니다.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {guideTab === "cli" && (
                <div>
                  <h3 style={{ margin: "0 0 8px", color: "var(--navy)" }}>터미널 실행 명령어 안내</h3>
                  <p style={{ color: "#64748b", margin: "0 0 8px" }}>Docker를 사용할 경우 (원클릭 추천):</p>
                  <div className="codeSnippet">docker compose up --build</div>

                  <p style={{ color: "#64748b", margin: "14px 0 8px" }}>로컬 개발 모드로 실행할 경우 (pnpm):</p>
                  <div className="codeSnippet">
                    # 1. pnpm이 없을 때: corepack enable 또는 npm i -g pnpm<br />
                    # 2. 의존성 및 브라우저 설치<br />
                    pnpm install<br />
                    pnpm playwright:install<br />
                    # 3. 개발 서버 구동 (API + Worker + Web)<br />
                    pnpm dev
                  </div>

                  <h3 style={{ margin: "20px 0 8px", color: "var(--navy)" }}>자주 묻는 질문 (FAQ)</h3>
                  <p style={{ margin: "0 0 4px", fontWeight: 700, color: "var(--navy)" }}>
                    Q. 테스트 케이스를 재생성하면 이전 결과가 지워지나요?
                  </p>
                  <p style={{ margin: "0 0 12px", color: "#64748b" }}>
                    아닙니다. 이미 결과가 있는 케이스는 아카이빙(보관)되어 과거 보고서의 무결성이 그대로 유지됩니다.
                  </p>
                  <p style={{ margin: "0 0 4px", fontWeight: 700, color: "var(--navy)" }}>
                    Q. 상세 가이드 파일은 어디에 있나요?
                  </p>
                  <p style={{ margin: 0, color: "#64748b" }}>
                    프로젝트 루트의 <code>USER_GUIDE.md</code>에 전체 기술 문서가 영구 보관되어 있습니다.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
