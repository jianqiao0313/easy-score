import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

function elementChildren(node, name) {
  return Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1 && (!name || child.localName === name || child.nodeName === name));
}

export function musicXmlWithSystemBreaks(source, measuresPerRow) {
  if (measuresPerRow === 'auto') return source;
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const parts = Array.from(document.getElementsByTagName('part'));
  for (const part of parts) {
    const measures = elementChildren(part, 'measure');
    measures.forEach((measure, index) => {
      const prints = elementChildren(measure, 'print');
      prints.forEach((print) => print.removeAttribute('new-system'));
      if (index === 0 || index % measuresPerRow !== 0) return;
      const print = prints[0] || document.createElement('print');
      print.setAttribute('new-system', 'yes');
      if (!prints.length) measure.insertBefore(print, measure.firstChild);
    });
  }
  return new XMLSerializer().serializeToString(document);
}

export function markMeasureRowEnds(sourceMeasures, measuresPerRow) {
  if (measuresPerRow === 'auto') return;
  for (let index = 0; index < (sourceMeasures?.length || 0); index += 1) {
    sourceMeasures[index].HasEndLine = (index + 1) % measuresPerRow === 0 || index === sourceMeasures.length - 1;
  }
}
