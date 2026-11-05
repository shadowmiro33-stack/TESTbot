// 기본값 "" = 같은 출처(/api/*)로 호출 → Next 서버가 API 로 프록시 (next.config.ts rewrites)
export const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
/** API 가 401(AUTH_REQUIRED)을 반환하면 발생 → 화면이 로그인 화면으로 전환 */
export const AUTH_EVENT = "autohands:auth-required";

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  try {
    // body 가 없는 POST 에 Content-Type: application/json 을 붙이면
    // Fastify 가 "Body cannot be empty" 400 을 반환하므로 body 가 있을 때만 지정합니다.
    const response = await fetch(`${API}${url}`, {
      ...options,
      // API 인증 세션 쿠키(HttpOnly)를 함께 보냄
      credentials: "include",
      headers: {
        ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options?.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && data.code === "AUTH_REQUIRED") {
      window.dispatchEvent(new Event(AUTH_EVENT));
      throw new Error("로그인이 필요합니다.");
    }
    if (!response.ok) throw new Error(data.message ?? "요청에 실패했습니다.");
    return data;
  } catch (err) {
    if (err instanceof TypeError && (err.message.includes("fetch") || err.message.includes("NetworkError"))) {
      throw new Error(
        `API 서버${API ? `(${API})` : ""}에 연결할 수 없습니다. 백엔드 API(포트 4000) 및 PostgreSQL이 실행 중인지 확인해주세요.`
      );
    }
    throw err;
  }
}

/** 파일 → base64 (data URL 접두어 제거) */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽을 수 없습니다."));
    reader.readAsDataURL(file);
  });
}

export const APP_PLATFORMS = new Set(["ANDROID", "IOS"]);
