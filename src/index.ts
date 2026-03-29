import './style.css';

export { Lightbox } from './lightbox';
export type { LightboxOptions } from './lightbox';

import { Lightbox } from './lightbox';

function autoInit(): void {
  if (!document.querySelector('[data-lightbox]')) return;
  const debug =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
  Lightbox.init(debug ? { debug: true } : undefined);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
}
