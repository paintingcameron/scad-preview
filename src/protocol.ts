/** Messages between the extension host and the webview. Shared by both bundles. */

export type ToWebview =
  | { type: 'status'; openscadPath: string; version?: string; error?: string }
  | { type: 'file'; name: string };

export type FromWebview = { type: 'ready' };
