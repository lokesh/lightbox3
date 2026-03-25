import './style.css';

export { Lightbox } from './lightbox';
export type { LightboxOptions } from './lightbox';

import { Lightbox } from './lightbox';

function autoInit(): void {
  if (!document.querySelector('[data-lightbox]')) return;
  Lightbox.init();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
}
