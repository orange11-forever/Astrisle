import type { ToolDefinition } from '../../contracts/src/index';
const string = {
    type: 'string',
  },
  strings = {
    type: 'array',
    items: string,
  };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    effect: 'write',
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}
export const runtimeTools: ToolDefinition[] = [
  tool(
    'ask_input',
    'Ask the user for necessary information or approval. Only this task waits; other branches continue.',
    {
      title: string,
      detail: string,
      kind: {
        type: 'string',
        enum: ['input', 'approval'],
      },
    },
    ['title', 'detail', 'kind'],
  ),
  tool(
    'submit_artifact',
    'Publish an actual file inside your task workspace as an immutable version. Call after writing it. Record the returned artifact and version IDs.',
    {
      path: string,
      name: string,
      mediaType: string,
    },
    ['path', 'name', 'mediaType'],
  ),
  tool(
    'complete_task',
    'Finish your assigned author task after publishing real deliverables. Completion is not independent verification.',
    {
      summary: string,
    },
    ['summary'],
  ),
  tool(
    'submit_review',
    'Review dependency artifacts. Evidence IDs must be actual successful tool evidence from this review against exact input versions. If unable to run verification use unable_to_verify.',
    {
      verdict: {
        type: 'string',
        enum: ['pass', 'changes_requested', 'unable_to_verify'],
      },
      summary: string,
      evidenceIds: strings,
      versionIds: strings,
    },
    ['verdict', 'summary', 'evidenceIds', 'versionIds'],
  ),
];
export const planTool: ToolDefinition = {
  name: 'propose_plan',
  effect: 'read',
  description:
    'Propose the complete task DAG. Each criterion needs an author and a separate reviewer, using mori and luma.',
  parameters: {
    type: 'object',
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'key',
            'title',
            'description',
            'kind',
            'agentId',
            'dependencies',
            'criterionIds',
          ],
          properties: {
            key: {
              type: 'string',
            },
            title: {
              type: 'string',
            },
            description: {
              type: 'string',
            },
            kind: {
              type: 'string',
            },
            agentId: {
              type: 'string',
            },
            dependencies: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            dependencyKinds: {
              type: 'object',
            },
            criterionIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    additionalProperties: false,
  },
};
