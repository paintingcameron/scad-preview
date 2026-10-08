/** Messages between the extension host and the webview. Shared by both bundles. */

export type ToWebview =
  | { type: 'status'; openscadPath: string; version?: string; error?: string }
  | { type: 'file'; name: string }
  | { type: 'settings'; defaultColor: string }
  | { type: 'renderStarted' }
  | { type: 'renderDone'; model: Uint8Array; facets?: number; ms: number; errors: number; warnings: number }
  | { type: 'renderEmpty'; ms: number; errors: number; warnings: number; firstProblem?: string }
  | { type: 'renderFailed'; message: string; ms: number };

export type FromWebview = { type: 'ready' } | { type: 'rerender' };
