import type { DiscoveryResult, TestStrategy } from '@autohands/shared';
import type { AIProvider, GeneratedCase } from './index.js';
import { RuleProvider } from './index.js';
import { OpenAIProvider } from './openai-provider.js';

export class HybridProvider implements AIProvider {
  private ruleProvider: RuleProvider;
  private openAIProvider: OpenAIProvider;

  constructor() {
    this.ruleProvider = new RuleProvider();
    this.openAIProvider = new OpenAIProvider();
  }

  async generateTestCases(discovery: DiscoveryResult, strategies: TestStrategy[]): Promise<GeneratedCase[]> {
    // 1. 규칙 기반 필수 테스트 케이스 생성
    const ruleCases = await this.ruleProvider.generateTestCases(discovery, strategies);

    // 2. OpenAI 기반 고부가가치 심층 시나리오 생성 시도
    let aiCases: GeneratedCase[] = [];
    try {
      aiCases = await this.openAIProvider.generateTestCases(discovery, strategies);
    } catch (err) {
      console.warn('[HybridProvider] AI 케이스 생성 실패, 규칙 기반 케이스만 유지합니다:', err);
    }

    // 3. 중복 타이틀 제거 및 병합
    const seenTitles = new Set(ruleCases.map((c) => c.title.trim()));
    const uniqueAiCases = aiCases.filter((c) => {
      const title = c.title?.trim();
      if (!title || seenTitles.has(title)) return false;
      seenTitles.add(title);
      return true;
    });

    console.log(
      `[HybridProvider] TC 생성 완료: 규칙 기반 ${ruleCases.length}건 + AI 기반 ${uniqueAiCases.length}건 (총 ${ruleCases.length + uniqueAiCases.length}건)`
    );

    return [...ruleCases, ...uniqueAiCases];
  }
}
