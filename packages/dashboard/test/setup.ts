/** @module dashboard/test/setup — registers happy-dom globals once per test process; import via `test/helpers/render.tsx` before React DOM */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: 'http://localhost:9876/', width: 1280, height: 800 });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
