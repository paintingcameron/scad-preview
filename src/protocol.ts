/** Messages between the extension host and the webview. Shared by both bundles. */
import type { ParamDef, ParamValue } from './customizer';

export type ToWebview =
  | { type: 'status'; openscadPath: string; version?: string; error?: string }
  | { type: 'file'; name: string }
  | { type: 'settings'; defaultColor: string }
  /** Parameter definitions plus the current overrides (values that differ from the defaults). */
  | { type: 'params'; defs: ParamDef[]; values: Record<string, ParamValue> }
  | { type: 'presets'; names: string[]; selected?: string }
  | { type: 'renderStarted'; draft: boolean }
  | { type: 'renderDone'; model: Uint8Array; facets?: number; ms: number; errors: number; warnings: number; draft: boolean }
  | { type: 'renderEmpty'; ms: number; errors: number; warnings: number; firstProblem?: string }
  | { type: 'renderFailed'; message: string; ms: number };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'rerender' }
  /** `draft` is true while a slider is being dragged. */
  | { type: 'setParams'; values: Record<string, ParamValue>; draft: boolean }
  /** `name` undefined means back to the file's defaults. */
  | { type: 'applyPreset'; name?: string }
  | { type: 'savePreset' }
  | { type: 'deletePreset' };
