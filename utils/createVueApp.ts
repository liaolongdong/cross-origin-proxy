import { createApp, type Component, type App } from 'vue';

const RESIZE_OBSERVER_ERROR_PATTERNS = [
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
];

const SUPPRESS_FLAG = '__resizeObserverErrorSuppressed__';

function isResizeObserverError(message: unknown): boolean {
  return typeof message === 'string' && RESIZE_OBSERVER_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

function suppressResizeObserverError(): void {
  // 仅在开发环境下抑制 ResizeObserver 错误，生产环境不需要
  if (!import.meta.env.DEV) return;

  const w = window as unknown as Record<string, unknown>;
  if (w[SUPPRESS_FLAG]) return;
  w[SUPPRESS_FLAG] = true;

  window.addEventListener(
    'error',
    event => {
      if (isResizeObserverError(event.message)) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true,
  );

  window.addEventListener(
    'unhandledrejection',
    event => {
      const reason = event.reason as { message?: unknown } | string | undefined;
      const message = typeof reason === 'string' ? reason : reason?.message;
      if (isResizeObserverError(message)) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true,
  );
}

/**
 * 创建并挂载 Vue 应用
 * 统一的应用初始化工厂函数，用于 options、popup 等入口
 */
export function createAndMountApp(rootComponent: Component, selector: string = '#app'): App {
  suppressResizeObserverError();
  const app = createApp(rootComponent);
  app.mount(selector);
  return app;
}
