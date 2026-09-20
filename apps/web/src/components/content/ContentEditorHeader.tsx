/**
 * Backwards-compatible re-export. The document header moved to
 * `workspace/DocumentHeader` as part of the R1 editor shell; this module keeps
 * the previous import path (and `SAVE_LABEL`) working for existing consumers.
 */
export { DocumentHeader as ContentEditorHeader, SAVE_LABEL } from './workspace/DocumentHeader';
export type { DocumentHeaderProps } from './workspace/DocumentHeader';
