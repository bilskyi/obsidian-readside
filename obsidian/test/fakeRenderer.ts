import { vi } from 'vitest';

/** Calls the tests check. */
export const fake = {
  goTo: vi.fn(async (..._args: unknown[]) => {}),
  /** The open renderers' location listeners: `emitLocation` plays the reader scrolling to a location. */
  locationListeners: new Set<(loc: unknown) => void>(),
  emitLocation(loc: unknown) {
    for (const l of [...this.locationListeners]) l(loc);
  },
  /** The open renderers' selection listeners: `emitSelection` plays the user selecting page text. */
  selectionListeners: new Set<(sel: unknown) => void>(),
  emitSelection(sel: unknown) {
    for (const l of [...this.selectionListeners]) l(sel);
  },
};

const off = () => () => {};

/** Stands in for src/renderers/pdf/PdfRenderer in plugin tests (vi.mock). */
export class FakePdfRenderer {
  private marginEl: HTMLDivElement;
  constructor(host: HTMLElement) {
    this.marginEl = document.createElement('div');
    this.marginEl.className = 'pdf-margin';
    host.appendChild(this.marginEl);
  }
  onSelection = (cb: (sel: unknown) => void) => {
    fake.selectionListeners.add(cb);
    return () => {
      fake.selectionListeners.delete(cb);
    };
  };
  currentSelection() {
    return null;
  }
  onHighlightClick = off;
  onLocationChange = (cb: (loc: unknown) => void) => {
    fake.locationListeners.add(cb);
    return () => {
      fake.locationListeners.delete(cb);
    };
  };
  onAnchorMismatch = off;
  onZoomChange = off;
  onPageLayout = off;
  findQuote = async () => null;
  paintHighlights() {}
  goTo = (...args: unknown[]) => fake.goTo(...args);
  async open() {}
  close() {}
  pageCount() {
    return 3;
  }
  getZoom() {
    return { zoom: 'fit-width', percent: 100 };
  }
  setZoom() {}
  async getOutline() {
    return [];
  }
  async getPageText() {
    return '';
  }
  async readingLinePoint() {
    return null;
  }
  pointAt() {
    return null;
  }
  search() {
    return (async function* () {})();
  }
  showSearchHits() {}
  clearSearch() {}
  marginLayer() {
    return this.marginEl;
  }
  setMarginWidth() {}
  anchorPoints(locations: unknown[]) {
    return locations.map(() => null);
  }
  setActiveHighlight() {}
  pageSize() {
    return { width: 600, height: 800 };
  }
}

/**
 * Stands in for src/renderers/epub/EpubRenderer in plugin tests (vi.mock): the fake PDF renderer plus the
 * `.pdf-scroller` an EPUB's PageUp/PageDown scroll (`fake.scrollBy` records each scroll).
 */
export class FakeEpubRenderer extends FakePdfRenderer {
  constructor(host: HTMLElement) {
    super(host);
    const scroller = document.createElement('div');
    scroller.className = 'pdf-scroller';
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    scroller.scrollBy = ((opts: ScrollToOptions) => epubFake.scrollBy(opts)) as typeof scroller.scrollBy;
    host.appendChild(scroller);
  }
}

export const epubFake = { scrollBy: vi.fn((_opts: ScrollToOptions) => {}) };
