import { discover, executeCase } from '@autohands/browser-runner';
import { createAIProvider } from '@autohands/test-generator';
const baseUrl = 'http://127.0.0.1:4179/demo.html';
async function main() {
  const discovery = await discover({ url: baseUrl }, 3);
  const cases = await createAIProvider().generateTestCases(discovery, ['NORMAL', 'EXCEPTION', 'BOUNDARY']);
  if (discovery.pages.length !== 1 || discovery.pages[0]!.forms !== 1 || cases.length < 5) throw new Error(`Unexpected discovery: ${JSON.stringify({ pages: discovery.pages.length, forms: discovery.pages[0]?.forms, cases: cases.length })}`);
  const normal = cases.find((item) => item.strategy === 'NORMAL')!;
  const result = await executeCase({ id: 'smoke', title: normal.title, strategy: normal.strategy, steps: normal.steps }, { baseUrl, production: false, outputDir: './work/smoke-artifacts' });
  if (result.result !== 'PASS') throw new Error(result.actual);
  console.log(JSON.stringify({ pages: discovery.pages.length, forms: discovery.pages[0]!.forms, inputs: discovery.pages[0]!.inputs.length, buttons: discovery.pages[0]!.buttons.length, apis: discovery.networkEndpoints.length, generatedCases: cases.length, execution: result.result }));
}
void main();
