const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (name, args) => {
    if (LEVELS[name] < threshold) return;
    const line = `[${timestamp()}] ${name.toUpperCase().padEnd(5)}`;
    const stream = name === 'error' ? console.error : name === 'warn' ? console.warn : console.log;
    stream(line, ...args);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}
