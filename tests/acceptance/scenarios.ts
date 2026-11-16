import { scenarioSchema, type AcceptanceScenario } from './schema';

const officeChecks = (suffix: string, total: number) => [
  {
    kind: 'office',
    path: `brief${suffix}.docx`,
    assertions: [{ at: ['paragraphs'], equals: ['星岛验收', `合计：${total}`] }],
  },
  {
    kind: 'office',
    path: `budget${suffix}.xlsx`,
    assertions: [
      { at: ['sheets', 0, 'name'], equals: 'Data' },
      {
        at: ['sheets', 0, 'rows'],
        equals: [
          ['Item', 'Value'],
          ['A', 10],
          ['B', total - 10],
          ['Total', total],
        ],
      },
    ],
    sums: [{ sheet: 'Data', range: 'B2:B3', sum: total }],
  },
  {
    kind: 'office',
    path: `deck${suffix}.pptx`,
    assertions: [
      { at: ['slides', 0, 'shapes', 0, 'text'], equals: '星岛验收' },
      { at: ['slides', 0, 'shapes', 1, 'text'], equals: `合计：${total}` },
    ],
  },
];
export const scenarios: AcceptanceScenario[] = [
  {
    id: 'code-new',
    title: '从零创建统计命令',
    stages: [
      {
        goal: 'Create stats.mjs, a dependency-free Node CLI. Read one JSON array of finite integers from stdin and print only JSON {count,sum,min,max}. For an empty array return {count:0,sum:0,min:null,max:null}. Accept negative integers. Publish the actual script, independently review it, and finish. Use only synthetic data. Do not install dependencies.',
        criteria: [
          'stats.mjs runs as a Node CLI with JSON stdin and produces exact statistics',
          'Empty input arrays and negative integers work',
        ],
        checks: [
          {
            kind: 'node',
            path: 'stats.mjs',
            input: '[3,-1,7,3]',
            json: { count: 4, sum: 12, min: -1, max: 7 },
          },
          {
            kind: 'node',
            path: 'stats.mjs',
            input: '[]',
            json: { count: 0, sum: 0, min: null, max: null },
          },
          {
            kind: 'node',
            path: 'stats.mjs',
            input: '[-8,-2]',
            json: { count: 2, sum: -10, min: -8, max: -2 },
          },
        ],
      },
    ],
  },
  {
    id: 'code-edit',
    title: '接手已有标签整理程序',
    seed: {
      'tags.mjs':
        "import { readFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\nconsole.log(JSON.stringify(input));\n",
      'README.txt': 'Keep this existing project note unchanged.\n',
    },
    stages: [
      {
        goal: 'Fix the existing tags.mjs Node CLI. It reads a JSON array from stdin. Return a JSON array of trimmed, lowercase, unique strings in JavaScript default sort order. Ignore non-string entries and empty strings. Preserve README.txt exactly. Publish changed files, independently review and finish. No dependencies.',
        criteria: [
          'Normalize, deduplicate and sort string tags; ignore non-strings and empty values',
          'Preserve README.txt',
        ],
        checks: [
          {
            kind: 'node',
            path: 'tags.mjs',
            input: '[" Beta ","alpha","ALPHA",null,5,""]',
            json: ['alpha', 'beta'],
          },
          { kind: 'node', path: 'tags.mjs', input: '[]', json: [] },
          { kind: 'node', path: 'tags.mjs', input: '[" 中文 ","中文","Ä"]', json: ['ä', '中文'] },
          {
            kind: 'text',
            path: 'README.txt',
            equals: 'Keep this existing project note unchanged.\n',
          },
        ],
      },
    ],
  },
  {
    id: 'office',
    title: 'Office 创建与后续修改',
    seed: {
      'source.json': JSON.stringify({
        title: '星岛验收',
        rows: [
          ['A', 10],
          ['B', 20],
        ],
        total: 30,
      }),
    },
    stages: [
      {
        goal: 'Read source.json and create three Office deliverables using the Office tools: brief.docx with exactly two paragraphs 星岛验收 and 合计：30; budget.xlsx with one Data sheet and rows [["Item","Value"],["A",10],["B",20],["Total",30]]; deck.pptx with one standard title/body slide titled 星岛验收 and body 合计：30. Keep all values numeric in the workbook. Read back all three files and independently verify the source-cell sum. Publish all files and finish. No target-application rendering is required.',
        criteria: [
          'DOCX and PPTX contain the specified title and total',
          'XLSX preserves source rows and the total is 30, verified numerically',
        ],
        checks: officeChecks('', 30),
      },
      {
        goal: 'Continue this Office project: B changes from 20 to 25, so total is 35. Use office_edit on existing brief.docx, budget.xlsx and deck.pptx to create brief-updated.docx, budget-updated.xlsx and deck-updated.pptx. Update totals to 合计：35 and spreadsheet B3=25,B4=35. Keep originals unchanged and preserve all other text/cells. Reopen and independently verify, publish only the three new files and finish.',
        criteria: [
          'Updated DOCX/PPTX show total 35 and XLSX has B=25,total=35',
          'All three original Office files retain their previous content',
        ],
        checks: [...officeChecks('-updated', 35), ...officeChecks('', 30)],
      },
    ],
  },
  {
    id: 'continuity',
    title: '同一工作空间的连续委托',
    stages: [
      {
        goal: 'Create status.json containing exactly {"phase":1,"items":["alpha"]}. Publish, independently review and finish.',
        criteria: ['status.json is valid JSON with phase=1 and items=["alpha"]'],
        checks: [{ kind: 'json', path: 'status.json', equals: { phase: 1, items: ['alpha'] } }],
      },
      {
        goal: 'Continue the existing project. Read status.json, preserve its existing alpha item, append beta once and set phase to 2. The final JSON must be {"phase":2,"items":["alpha","beta"]}. Publish the updated file, independently review and finish.',
        criteria: ['Existing alpha is preserved, beta added once and phase becomes 2'],
        checks: [
          { kind: 'json', path: 'status.json', equals: { phase: 2, items: ['alpha', 'beta'] } },
        ],
      },
    ],
  },
].map((scenario) => scenarioSchema.parse(scenario));
