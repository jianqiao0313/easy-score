import { markMeasureRowEnds, musicXmlWithSystemBreaks } from './score-layout.mjs';
import { syncCursorToBeat } from './cursor.mjs';

function configureEngraving(osmdInstance) {
  const rules = osmdInstance.EngravingRules;
  rules.FixedMeasureWidth = true;
  rules.FixedMeasureWidthUseForPickupMeasures = true;
  rules.StretchLastSystemLine = false;
  rules.LastSystemMaxScalingFactor = 1;
  rules.NewPartAndSystemAfterFinalBarline = true;
  rules.ShowRhythmAgainAfterPartEndOrFinalBarline = false;
}

function measuredFixedWidth(osmdInstance) {
  const widths = (osmdInstance.GraphicSheet?.MeasureList || []).flat()
    .map((measure) => measure?.minimumStaffEntriesWidth)
    .filter((width) => Number.isFinite(width) && width > 0);
  return widths.length ? Math.max(...widths) : 0;
}

function requiredScoreViewWidth(osmdInstance, measuresPerRow) {
  const rules = osmdInstance.EngravingRules;
  const systems = (osmdInstance.GraphicSheet?.MusicPages || []).flatMap((page) => page.MusicSystems || []);
  const measureWidths = (osmdInstance.GraphicSheet?.MeasureList || []).map((staffMeasures) => Math.max(0, ...staffMeasures
    .filter(Boolean)
    .map((measure) => measure.beginInstructionsWidth + measure.minimumStaffEntriesWidth + measure.endInstructionsWidth)));
  const rowWidths = [];
  for (let index = 0; index < measureWidths.length; index += measuresPerRow) {
    rowWidths.push(measureWidths.slice(index, index + measuresPerRow).reduce((sum, width) => sum + width, 0));
  }
  const labelWidth = Math.max(0, ...systems.map((system) => system.MaxLabelLength || 0)) + rules.SystemLabelsRightMargin;
  const systemWidth = Math.max(0, ...rowWidths) + labelWidth;
  const margins = rules.PageLeftMargin + rules.PageRightMargin + rules.SystemLeftMargin + rules.SystemRightMargin;
  return Math.ceil((systemWidth + margins) * 10 * (osmdInstance.Zoom || 1)) + 56;
}

function dispose(display) {
  if (!display) return;
  try { display.setOptions({ autoResize: false }); } catch { /* Cleanup must not prevent replacement. */ }
  try { display.clear(); } catch { /* Its owned DOM is removed separately. */ }
}

export class ScoreRenderer {
  constructor({ scoreView, container, viewport, fontReady, loadDisplay = async () => (await import('opensheetmusicdisplay')).OpenSheetMusicDisplay }) {
    this.scoreView = scoreView;
    this.container = container;
    this.viewport = viewport;
    this.fontReady = fontReady;
    this.loadDisplay = loadDisplay;
    this.revision = 0;
    this.cursorBeat = -1;
    this.width = 0;
    this.pending = false;
  }

  automaticWidth() {
    const style = this.viewport.ownerDocument.defaultView.getComputedStyle(this.viewport);
    return Math.max(1, Math.min(900, this.viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
  }

  async render(source, { measuresPerRow, isCurrent = () => true }) {
    const revision = ++this.revision;
    const current = () => revision === this.revision && isCurrent();
    this.pending = true;
    let stage;
    let next;
    let committed = false;
    try {
      // A failed download can be retried on the next import.
      this.displayReady ||= this.loadDisplay().catch((error) => { this.displayReady = null; throw error; });
      const [Display] = await Promise.all([this.displayReady, this.fontReady]);
      if (!current()) return false;
      const automatic = measuresPerRow === 'auto';
      let width = this.automaticWidth();
      stage = this.scoreView.cloneNode(false);
      stage.removeAttribute('id');
      stage.removeAttribute('role');
      stage.removeAttribute('aria-labelledby');
      stage.setAttribute('aria-hidden', 'true');
      stage.hidden = false;
      stage.classList.add('is-measuring');
      stage.style.minWidth = '';
      stage.style.width = `${width}px`;
      const container = this.scoreView.ownerDocument.createElement('div');
      container.className = 'osmd-container';
      container.setAttribute('aria-label', '识别后的乐谱');
      stage.appendChild(container);
      this.viewport.appendChild(stage);
      next = new Display(container, {
        autoResize: false, backend: 'svg', drawTitle: true, drawingParameters: 'compacttight',
        followCursor: false, newSystemFromXML: !automatic, defaultFontFamily: 'Source Han Sans CN VF',
      });
      await next.load(musicXmlWithSystemBreaks(source, measuresPerRow));
      if (!current()) return false;
      // ResizeObserver may run while load is pending. Measure again at the
      // synchronous render boundary so that resize cannot be lost.
      width = this.automaticWidth();
      stage.style.width = `${width}px`;
      markMeasureRowEnds(next.Sheet?.SourceMeasures, measuresPerRow);
      if (!automatic) configureEngraving(next);
      next.render();
      const fixedWidth = automatic ? 0 : measuredFixedWidth(next);
      if (fixedWidth) {
        next.EngravingRules.FixedMeasureWidthFixedValue = fixedWidth;
        stage.style.minWidth = `${requiredScoreViewWidth(next, measuresPerRow)}px`;
        stage.style.width = stage.style.minWidth;
        next.render();
      }
      next.cursor?.show();
      next.cursor?.reset();
      if (!current()) return false;

      // All fallible layout work finishes before touching the current score.
      const previous = this.instance;
      const containerId = this.container.id;
      this.scoreView.replaceChildren(container);
      container.id = containerId;
      this.scoreView.style.minWidth = stage.style.minWidth;
      this.scoreView.style.width = stage.style.width;
      this.container = container;
      this.instance = next;
      this.layout = measuresPerRow;
      this.width = width;
      this.cursorBeat = -1;
      committed = true;
      dispose(previous);
      return true;
    } catch (error) {
      if (!current()) return false;
      throw new Error(`乐谱排版失败：${error.message}`, { cause: error });
    } finally {
      if (!committed) dispose(next);
      stage?.remove();
      if (revision === this.revision) this.pending = false;
    }
  }

  setFollowing(followCursor) {
    this.instance?.setOptions({ followCursor });
  }

  syncCursor(beat) {
    const cursor = this.instance?.cursor;
    if (!cursor) return;
    try {
      syncCursorToBeat(cursor, beat, { reset: beat < this.cursorBeat || this.cursorBeat < 0 });
      this.cursorBeat = beat;
    } catch {
      cursor.hide();
    }
  }

  clear() {
    this.revision++;
    this.pending = false;
    dispose(this.instance);
    this.container.replaceChildren();
    this.instance = undefined;
    this.cursorBeat = -1;
    this.width = 0;
    this.layout = undefined;
  }
}
