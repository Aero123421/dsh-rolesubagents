/**
 * Page stylesheet, injected once as `<style data-plugin="dsh-rolesubagents">` and
 * removed when the plugin unloads. Every class is prefixed `dshrs-`. Colors come
 * from DSH's theme variables (`--dsw-alias-*`) with light fallbacks, so the
 * light and dark themes apply on their own. Narrow widths are handled with a
 * container query on the page root, because the page sits inside a card whose
 * width is not the viewport's.
 */

export const STYLE_ATTRIBUTE = 'dsh-rolesubagents'

export const STYLES = /* css */ `
.dshrs-root {
  --dshrs-bg: var(--dsw-alias-bg-base, #ffffff);
  --dshrs-field: var(--dsw-alias-bg-module-platform, #f5f6f7);
  --dshrs-field-hover: color-mix(in srgb, var(--dshrs-field) 94%, var(--dshrs-text));
  --dshrs-fill: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --dshrs-fill-strong: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.1));
  --dshrs-text: var(--dsw-alias-label-primary, #0f1115);
  --dshrs-text2: var(--dsw-alias-label-secondary, #61666b);
  --dshrs-text3: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 78%, var(--dshrs-text));
  --dshrs-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  --dshrs-line-strong: var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16));
  --dshrs-primary: var(--dsw-alias-button-primary-fill, #0f1115);
  --dshrs-primary-hover: var(--dsw-alias-button-primary-hover, #43454a);
  --dshrs-on-primary: var(--dsw-alias-label-primary-foreground, #ffffff);
  --dshrs-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --dshrs-accent-ink: color-mix(in srgb, var(--dshrs-accent) 82%, var(--dshrs-text));
  --dshrs-accent-tint: color-mix(in srgb, var(--dshrs-accent) 14%, transparent);
  --dshrs-err: var(--dsw-alias-state-error-primary, #ec1313);
  --dshrs-err-ink: color-mix(in srgb, var(--dshrs-err) 80%, var(--dshrs-text));
  --dshrs-err-tint: color-mix(in srgb, var(--dshrs-err) 9%, transparent);
  --dshrs-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshrs-warn-ink: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 68%, var(--dshrs-text));
  --dshrs-warn-tint: color-mix(in srgb, var(--dshrs-warn) 13%, transparent);
  --dshrs-ok-ink: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 62%, var(--dshrs-text));
  --dshrs-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshrs-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  container: dshrs-root / inline-size;
  display: grid; gap: 20px; min-width: 0;
  color: var(--dshrs-text); font-family: inherit; font-size: 14px; line-height: 1.6;
  text-size-adjust: 100%;
}
.dshrs-root *, .dshrs-root *::before, .dshrs-root *::after { box-sizing: border-box; }
.dshrs-root :focus { outline: none; }
.dshrs-root :focus-visible { outline: 2px solid var(--dshrs-accent); outline-offset: 2px; }
.dshrs-root p, .dshrs-root h3, .dshrs-root h4, .dshrs-root ul, .dshrs-root fieldset { margin: 0; }
.dshrs-root ul { padding: 0; list-style: none; }
.dshrs-hint { color: var(--dshrs-text3); font-size: 12.5px; line-height: 1.55; }
.dshrs-mono { font-family: var(--dshrs-mono); font-size: 13px; }
.dshrs-heading { font-size: 15px; line-height: 24px; font-weight: 500; }
.dshrs-sub { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dshrs-text2); }
.dshrs-section { display: grid; gap: 10px; min-width: 0; }
.dshrs-bar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.dshrs-bar-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

.dshrs-notice {
  padding: 10px 14px; border-radius: 10px; background: var(--dshrs-fill); color: var(--dshrs-text2);
  overflow-wrap: anywhere;
}
.dshrs-notice--warn { background: var(--dshrs-warn-tint); color: var(--dshrs-warn-ink); }
.dshrs-notice--error { background: var(--dshrs-err-tint); color: var(--dshrs-err-ink); }
.dshrs-notice ul { list-style: disc; padding-left: 1.25em; display: grid; gap: 2px; margin-top: 4px; }

.dshrs-btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dshrs-line-strong);
  font: inherit; font-size: 13px; line-height: 1; cursor: pointer; white-space: nowrap;
  color: var(--dshrs-text); background: transparent;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.dshrs-btn:hover:not(:disabled) { background: var(--dshrs-fill); }
.dshrs-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshrs-btn--primary { background: var(--dshrs-primary); color: var(--dshrs-on-primary); border-color: transparent; font-weight: 500; }
.dshrs-btn--primary:hover:not(:disabled) { background: var(--dshrs-primary-hover); }
.dshrs-btn--ghost { border-color: transparent; color: var(--dshrs-text2); }
.dshrs-btn--ghost:hover:not(:disabled) { color: var(--dshrs-text); }
.dshrs-btn--danger { border-color: transparent; color: var(--dshrs-err-ink); }
.dshrs-btn--danger:hover:not(:disabled) { background: var(--dshrs-err-tint); }
.dshrs-btn[aria-busy='true'] { cursor: progress; }

.dshrs-switch {
  appearance: none; flex: none; position: relative; width: 36px; height: 20px; padding: 0; margin: 0;
  border-radius: 10px; border: 0; background: var(--dshrs-idle); cursor: pointer; transition: background-color 140ms ease;
}
.dshrs-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 140ms ease;
}
.dshrs-switch[aria-checked='true'] { background: var(--dshrs-primary); }
.dshrs-switch[aria-checked='true']::after { transform: translateX(16px); background: var(--dshrs-on-primary); }
.dshrs-switch:disabled { opacity: 0.4; cursor: not-allowed; }

.dshrs-master { display: flex; gap: 14px; align-items: flex-start; }
.dshrs-master-text { display: grid; gap: 2px; min-width: 0; }

.dshrs-list { display: grid; gap: 8px; }
.dshrs-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; align-items: start;
  padding: 10px 12px; border: 1px solid var(--dshrs-line); border-radius: 12px; min-width: 0;
}
.dshrs-row.dshrs-off .dshrs-row-main { opacity: 0.6; }
.dshrs-row.dshrs-open { border-color: var(--dshrs-line-strong); }
.dshrs-row-main { display: grid; gap: 4px; min-width: 0; }
.dshrs-row-title { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; min-width: 0; }
.dshrs-row-id { font-family: var(--dshrs-mono); font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.dshrs-row-model { color: var(--dshrs-text3); font-size: 12.5px; overflow-wrap: anywhere; }
.dshrs-row-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; }
.dshrs-row-editor { grid-column: 1 / -1; border-top: 1px solid var(--dshrs-line); padding-top: 12px; }
@container dshrs-root (min-width: 640px) {
  .dshrs-row { grid-template-columns: auto minmax(0, 1fr) auto; }
  .dshrs-row-actions { grid-column: auto; justify-content: flex-end; }
}

.dshrs-badge {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px;
  font-size: 12px; line-height: 1; white-space: nowrap; background: var(--dshrs-fill-strong); color: var(--dshrs-text2);
}
.dshrs-badge--fork { background: var(--dshrs-accent-tint); color: var(--dshrs-accent-ink); }
.dshrs-badge--ro { background: var(--dshrs-warn-tint); color: var(--dshrs-warn-ink); }
.dshrs-badge--err { background: var(--dshrs-err-tint); color: var(--dshrs-err-ink); }
.dshrs-badge--quiet { background: transparent; box-shadow: inset 0 0 0 1px var(--dshrs-line-strong); color: var(--dshrs-text3); }

.dshrs-editor { display: grid; gap: 16px; min-width: 0; }
.dshrs-field { display: grid; gap: 6px; min-width: 0; align-content: start; }
.dshrs-label { font-size: 13px; font-weight: 500; line-height: 20px; }
.dshrs-error { color: var(--dshrs-err-ink); font-size: 12.5px; line-height: 1.5; }
.dshrs-counter { color: var(--dshrs-text3); font-size: 12px; font-variant-numeric: tabular-nums; }
.dshrs-counter.dshrs-over { color: var(--dshrs-err-ink); }
.dshrs-input, .dshrs-textarea, .dshrs-select {
  font: inherit; font-size: 14px; color: var(--dshrs-text); background: var(--dshrs-field);
  border: 1px solid transparent; border-radius: 8px; width: 100%; min-width: 0;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dshrs-input:hover:not(:disabled), .dshrs-textarea:hover:not(:disabled), .dshrs-select:hover:not(:disabled) {
  background: var(--dshrs-field-hover);
}
.dshrs-input { height: 34px; padding: 0 12px; }
.dshrs-input.dshrs-mono { font-family: var(--dshrs-mono); font-size: 13px; }
.dshrs-select { height: 34px; padding: 0 8px; cursor: pointer; text-overflow: ellipsis; }
.dshrs-select option { color: initial; }
.dshrs-textarea { padding: 8px 12px; resize: vertical; line-height: 1.55; min-height: 72px; display: block; }
.dshrs-input:disabled, .dshrs-textarea:disabled, .dshrs-select:disabled { opacity: 0.55; cursor: not-allowed; }
.dshrs-input[aria-invalid='true'], .dshrs-textarea[aria-invalid='true'], .dshrs-select[aria-invalid='true'] {
  border-color: var(--dshrs-err);
}
.dshrs-group { border: 0; padding: 0; min-width: 0; display: grid; gap: 8px; }
.dshrs-group > legend { padding: 0; margin-bottom: 8px; font-size: 13px; font-weight: 500; line-height: 20px; }
.dshrs-choice { display: flex; gap: 10px; align-items: flex-start; line-height: 1.55; cursor: pointer; }
.dshrs-choice input { margin: 4px 0 0; width: 16px; height: 16px; flex: none; accent-color: var(--dshrs-primary); }
.dshrs-choice input:disabled { cursor: not-allowed; }
.dshrs-model-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }

.dshrs-preview { display: grid; gap: 10px; padding: 12px; border-radius: 10px; background: var(--dshrs-field); }
.dshrs-pre {
  margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dshrs-bg); border: 1px solid var(--dshrs-line);
  font-family: var(--dshrs-mono); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
}

.dshrs-footer {
  position: sticky; bottom: 0; z-index: 1; display: grid; gap: 8px; padding: 12px 0 4px;
  background: var(--dshrs-bg); border-top: 1px solid var(--dshrs-line);
}
.dshrs-footer-bar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.dshrs-status { min-width: 0; flex: 1 1 220px; color: var(--dshrs-text2); overflow-wrap: anywhere; }
.dshrs-status.dshrs-ok { color: var(--dshrs-ok-ink); }
.dshrs-status.dshrs-bad { color: var(--dshrs-err-ink); }
.dshrs-footer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@container dshrs-root (max-width: 480px) {
  .dshrs-footer-actions { width: 100%; }
  .dshrs-footer-actions .dshrs-btn { flex: 1 1 auto; }
  .dshrs-bar-actions { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dshrs-switch, .dshrs-switch::after, .dshrs-btn, .dshrs-input, .dshrs-textarea, .dshrs-select { transition: none; }
}
`

/**
 * Add the stylesheet to the document.
 * @param doc - the page's document.
 * @returns a function that removes it again.
 */
export function installStyles(doc: Document): () => void {
  const style = doc.createElement('style')
  style.setAttribute('data-plugin', STYLE_ATTRIBUTE)
  style.textContent = STYLES
  doc.head.append(style)
  return () => style.remove()
}
