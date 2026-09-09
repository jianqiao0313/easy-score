import assert from 'node:assert/strict';
import test from 'node:test';
import { ScoreRenderer } from '../src/score-renderer.mjs';

const XML = '<score-partwise><part-list/><part><measure number="1"/></part></score-partwise>';

// A small DOM fixture exercises ownership and atomic replacement without a browser dependency.
function element(document) {
  return {
    ownerDocument: document, children: [], style: {}, classList: { add() {} }, id: '',
    cloneNode() { return element(document); },
    removeAttribute(name) { delete this[name]; },
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; },
    replaceChildren(...children) { this.children.forEach((child) => { child.parentNode = null; }); this.children = []; children.forEach((child) => this.appendChild(child)); },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; },
  };
}

function fixture() {
  const document = { defaultView: { getComputedStyle: () => ({ paddingLeft: '20px', paddingRight: '20px' }) } };
  document.createElement = () => element(document);
  const viewport = element(document);
  viewport.clientWidth = 1000;
  const scoreView = element(document);
  const container = element(document);
  container.id = 'osmdContainer';
  scoreView.appendChild(container);
  viewport.appendChild(scoreView);
  const created = [];
  let next = {};
  let loads = 0;
  class Display {
    constructor(target) {
      this.target = target;
      this.behavior = next;
      this.cursor = { show: () => { if (this.behavior.failCursor) throw new Error('cursor failed'); }, reset() {}, hide() {} };
      this.EngravingRules = { SystemLabelsRightMargin: 1, PageLeftMargin: 1, PageRightMargin: 1, SystemLeftMargin: 1, SystemRightMargin: 1 };
      this.GraphicSheet = { MeasureList: [[{ minimumStaffEntriesWidth: 20, beginInstructionsWidth: 1, endInstructionsWidth: 1 }]] };
      this.Sheet = { SourceMeasures: [{}] };
      this.renderCount = 0;
      created.push(this);
    }
    async load() { await this.behavior.wait; if (this.behavior.failLoad) throw new Error('load failed'); }
    render() {
      this.target.replaceChildren(element(document));
      this.renderCount++;
      if (this.behavior.failRender === this.renderCount) throw new Error('render failed');
    }
    setOptions() {}
    clear() { this.cleared = true; this.target.replaceChildren(); }
  }
  const renderer = new ScoreRenderer({ scoreView, container, viewport, fontReady: Promise.resolve(), loadDisplay: async () => { loads++; return Display; } });
  return { renderer, viewport, scoreView, created, loads: () => loads, next: (behavior) => { next = behavior; } };
}

test('display dependency is loaded only on first render and reused', async () => {
  const f = fixture();
  assert.equal(f.loads(), 0);
  assert.equal(await f.renderer.render(XML, { measuresPerRow: 'auto' }), true);
  assert.equal(f.renderer.width, 900);
  assert.equal(f.scoreView.children[0], f.created[0].target);
  await f.renderer.render(XML, { measuresPerRow: 4 });
  assert.equal(f.loads(), 1);
  assert.equal(f.created[0].cleared, true);
  assert.equal(f.created[1].renderCount, 2);
  assert.equal(f.scoreView.children[0].id, 'osmdContainer');
  assert.equal(f.viewport.children.length, 1);
});

for (const behavior of [{ failLoad: true }, { failRender: 1 }, { failRender: 2 }, { failCursor: true }]) {
  test(`failed replacement keeps previous drawing, instance and layout: ${JSON.stringify(behavior)}`, async () => {
    const f = fixture();
    await f.renderer.render(XML, { measuresPerRow: 'auto' });
    const previous = f.renderer.instance;
    const drawing = f.scoreView.children[0].children[0];
    const style = { ...f.scoreView.style };
    f.next(behavior);
    await assert.rejects(f.renderer.render(XML, { measuresPerRow: 4 }), /乐谱排版失败/);
    assert.equal(f.renderer.instance, previous);
    assert.equal(previous.cleared, undefined);
    assert.equal(f.scoreView.children[0].children[0], drawing);
    assert.deepEqual(f.scoreView.style, style);
    assert.equal(f.renderer.layout, 'auto');
    assert.equal(f.created[1].cleared, true);
    assert.equal(f.viewport.children.length, 1);
  });
}

test('a later render wins when an earlier load completes last', async () => {
  const f = fixture();
  let finish;
  f.next({ wait: new Promise((resolve) => { finish = resolve; }) });
  const stale = f.renderer.render(XML, { measuresPerRow: 4 });
  // Let the first display enter load before starting the second request.
  await new Promise((resolve) => setImmediate(resolve));
  f.next({});
  await f.renderer.render(XML, { measuresPerRow: 'auto' });
  const current = f.renderer.instance;
  finish();
  assert.equal(await stale, false);
  assert.equal(f.renderer.instance, current);
  assert.equal(f.created[0].cleared, true);
  assert.equal(f.viewport.children.length, 1);
});

test('clearing during a load prevents it from committing and releases its staging DOM', async () => {
  const f = fixture();
  let finish;
  f.next({ wait: new Promise((resolve) => { finish = resolve; }) });
  const pending = f.renderer.render(XML, { measuresPerRow: 'auto' });
  await new Promise((resolve) => setImmediate(resolve));
  f.renderer.clear();
  finish();
  assert.equal(await pending, false);
  assert.equal(f.renderer.instance, undefined);
  assert.equal(f.viewport.children.length, 1);
  assert.equal(f.created[0].cleared, true);
});

test('a failed dependency download is retried on the next render', async () => {
  const f = fixture();
  const loader = f.renderer.loadDisplay;
  f.renderer.loadDisplay = async () => { throw new Error('offline'); };
  await assert.rejects(f.renderer.render(XML, { measuresPerRow: 'auto' }), /offline/);
  assert.equal(f.renderer.pending, false);
  assert.equal(f.viewport.children.length, 1);
  f.renderer.loadDisplay = loader;
  assert.equal(await f.renderer.render(XML, { measuresPerRow: 'auto' }), true);
});

test('an invalidated import never replaces the current score', async () => {
  const f = fixture();
  await f.renderer.render(XML, { measuresPerRow: 'auto' });
  const previous = f.renderer.instance;
  let finish;
  let valid = true;
  f.next({ wait: new Promise((resolve) => { finish = resolve; }) });
  const pending = f.renderer.render(XML, { measuresPerRow: 4, isCurrent: () => valid });
  await new Promise((resolve) => setImmediate(resolve));
  valid = false;
  finish();
  assert.equal(await pending, false);
  assert.equal(f.renderer.instance, previous);
  assert.equal(f.renderer.pending, false);
  assert.equal(f.created[1].cleared, true);
});

test('automatic layout uses the latest viewport width when it changes during load', async () => {
  const f = fixture();
  let finish;
  f.next({ wait: new Promise((resolve) => { finish = resolve; }) });
  const pending = f.renderer.render(XML, { measuresPerRow: 'auto' });
  await new Promise((resolve) => setImmediate(resolve));
  f.viewport.clientWidth = 700;
  finish();
  await pending;
  assert.equal(f.renderer.width, 660);
  assert.equal(f.scoreView.style.width, '660px');
});
