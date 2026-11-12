import { usePanelLayout } from '../../panels/usePanelLayout';

export const CONTENTS_MIN = 200;
export const CONTENTS_MAX = 480;
export const CONTENTS_DEFAULT = 260;

const LAYOUT = {
  openKey: 'margin.contents.open',
  widthKey: 'margin.contents.width',
  min: CONTENTS_MIN,
  max: CONTENTS_MAX,
  defaultWidth: CONTENTS_DEFAULT,
};

/** Contents sidebar open state and width, remembered per device (like the notebook). */
export function useContentsLayout() {
  return usePanelLayout(LAYOUT);
}
