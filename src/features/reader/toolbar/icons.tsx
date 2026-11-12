import type { SVGProps } from 'react';

/** 16px line icons in currentColor; always decorative (the button carries the name). */
const Svg = (props: SVGProps<SVGSVGElement>) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...props}
  />
);

/** Books on a shelf: the Obsidian reader's way back to its shelf. */
export const LibraryIcon = () => (
  <Svg>
    <path d="M3 2.5v11M6 2.5v11M9.2 3.2l3.3 10.1M2 13.5h12" />
  </Svg>
);
export const ChevronLeftIcon = () => <Svg><path d="M10 3.5 5.5 8l4.5 4.5" /></Svg>;
export const ChevronRightIcon = () => <Svg><path d="M6 3.5 10.5 8 6 12.5" /></Svg>;
export const MinusIcon = () => <Svg><path d="M3.5 8h9" /></Svg>;
export const PlusIcon = () => <Svg><path d="M8 3.5v9M3.5 8h9" /></Svg>;
export const SearchIcon = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Svg>
);
export const ContentsIcon = () => (
  <Svg>
    <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
    <path d="M2.75 4h.01M2.75 8h.01M2.75 12h.01" strokeWidth="2" />
  </Svg>
);
export const NotebookIcon = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M10 2.5v11" />
  </Svg>
);
export const ArrowUpIcon = () => <Svg><path d="M8 12.5v-9M4 7.5l4-4 4 4" /></Svg>;
export const ArrowDownIcon = () => <Svg><path d="M8 3.5v9M4 8.5l4 4 4-4" /></Svg>;
export const CloseIcon = () => <Svg><path d="m4 4 8 8M12 4l-8 8" /></Svg>;
/** Focus mode: four corners closing in on the page. */
export const FocusIcon = () => (
  <Svg>
    <path d="M2.75 6V3.5a.75.75 0 0 1 .75-.75H6M10 2.75h2.5a.75.75 0 0 1 .75.75V6M13.25 10v2.5a.75.75 0 0 1-.75.75H10M6 13.25H3.5a.75.75 0 0 1-.75-.75V10" />
  </Svg>
);
