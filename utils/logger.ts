const PREFIX = '[CrossOriginProxy]';

export const logger = {
  debug(...args: any[]) {
    if (import.meta.env.DEV) {
      console.debug(PREFIX, ...args);
    }
  },
  info(...args: any[]) {
    if (import.meta.env.DEV) {
      console.info(PREFIX, ...args);
    }
  },
  warn(...args: any[]) {
    console.warn(PREFIX, ...args);
  },
  error(...args: any[]) {
    console.error(PREFIX, ...args);
  },
};
