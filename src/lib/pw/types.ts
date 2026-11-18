// Pagewise — shared tool contracts.
// Every tool (client, server or AI) is described by a ToolDef and driven by the
// same UI flow: pick tool -> files -> options -> run -> progress -> results.

export type OptValue = string | number | boolean;
export type OptionValues = Record<string, OptValue>;

export interface OutFile {
  name: string;
  blob: Blob;
  /** Optional human-readable summary, e.g. "812 KB -> 310 KB (62% smaller)". */
  info?: string;
}

export type RunCtx = {
  onProgress: (message: string, percent?: number) => void;
};

export type ClientRun = (
  files: File[],
  opts: OptionValues,
  ctx: RunCtx
) => Promise<OutFile[]>;

interface ToolOptionBase {
  key: string;
  label: string;
  help?: string;
  /** Only show this field when the predicate over current values is true. */
  showIf?: (v: OptionValues) => boolean;
}

export type ToolOption = ToolOptionBase & (
  | { type: 'select'; default: string; choices: { value: string; label: string }[] }
  | { type: 'number'; default: number; min?: number; max?: number; step?: number }
  | { type: 'slider'; default: number; min: number; max: number; step?: number }
  | { type: 'text'; default: string; placeholder?: string; multiline?: boolean }
  | { type: 'pages'; default: string; placeholder?: string }
  | { type: 'checkbox'; default: boolean }
  | { type: 'color'; default: string }
);

export type ToolGroup =
  | 'organize'
  | 'optimize'
  | 'to-pdf'
  | 'from-pdf'
  | 'edit'
  | 'security'
  | 'intelligence';

export type Engine = 'client' | 'server' | 'ai';

/** Tools whose options UI is replaced by a dedicated editor component. */
export type CustomEditor =
  | 'organize'
  | 'crop'
  | 'sign'
  | 'edit'
  | 'redact'
  | 'scan'
  | 'compare';

export type Privacy = 'local' | 'server' | 'text-only';

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  group: ToolGroup;
  /** Key resolved against the icon map in components/pw/icons.ts. */
  icon: string;
  /** HTML input accept attribute. */
  accept: string;
  multi?: boolean;
  minFiles?: number;
  maxFiles?: number;
  engine: Engine;
  options: ToolOption[];
  /** engine === 'client' */
  run?: ClientRun;
  /** engine === 'server' — id handled by /api/pw/jobs */
  serverTool?: string;
  /** engine === 'ai' — id handled by /api/pw/ai */
  aiTool?: string;
  /** Replaces the standard options+run flow with a dedicated editor UI. */
  custom?: CustomEditor;
  privacy: Privacy;
  note?: string;
  badge?: 'Beta' | 'New' | 'Server' | 'AI';
}

/** Props every custom editor receives from the Workspace. */
export interface EditorProps {
  files: File[];
  opts: OptionValues;
  onProgress: (message: string, percent?: number) => void;
  onDone: (results: OutFile[], info?: string) => void;
  onError: (message: string) => void;
}

export function defaultsOf(tool: ToolDef): OptionValues {
  const v: OptionValues = {};
  for (const o of tool.options) v[o.key] = o.default as OptValue;
  return v;
}

export const GROUP_META: Record<
  ToolGroup,
  { label: string; blurb: string }
> = {
  organize: { label: 'Organize', blurb: 'Merge, split, reorder and rotate pages' },
  optimize: { label: 'Optimize', blurb: 'Shrink and repair documents' },
  'to-pdf': { label: 'Convert to PDF', blurb: 'Turn images, office files and HTML into PDFs' },
  'from-pdf': { label: 'Convert from PDF', blurb: 'PDF into images, office formats and archives' },
  edit: { label: 'Edit', blurb: 'Stamp, annotate, sign, redact and compare' },
  security: { label: 'Security', blurb: 'Encrypt, unlock and control access' },
  intelligence: { label: 'Intelligence', blurb: 'AI summaries, translation and markdown' },
};
