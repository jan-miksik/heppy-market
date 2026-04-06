/**
 * Structured logger for the initRoot agent system.
 *
 * Emits machine-readable key=value lines compatible with wrangler tail and
 * Cloudflare Logpush. Every log line includes a timestamp, level, service,
 * and optional agentId so logs can be easily filtered in production.
 *
 * Usage:
 *   const log = createLogger('agent-loop', agentId);
 *   log.info('tick_start', { pairs: 3 });
 *   const done = log.time('market_data_fetch');
 *   // ... do work ...
 *   done();  // emits timing line automatically
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
}

function emit(level: LogLevel, service: string, agentId: string | undefined, event: string, fields: LogFields): void {
  const ts = new Date().toISOString();
  const agentPart = agentId ? ` agent=${agentId}` : '';
  const fieldPart = Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : '';
  const line = `[${service}]${agentPart} ts=${ts} level=${level} event=${event}${fieldPart}`;

  switch (level) {
    case 'debug': console.debug(line); break;
    case 'info':  console.log(line);   break;
    case 'warn':  console.warn(line);  break;
    case 'error': console.error(line); break;
  }
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Start a timer. Call the returned function when the operation completes — it auto-logs the duration. */
  time(event: string, fields?: LogFields): () => number;
}

/** Create a logger bound to a service name and optional agentId. */
export function createLogger(service: string, agentId?: string): Logger {
  return {
    debug: (event, fields = {}) => emit('debug', service, agentId, event, fields),
    info:  (event, fields = {}) => emit('info',  service, agentId, event, fields),
    warn:  (event, fields = {}) => emit('warn',  service, agentId, event, fields),
    error: (event, fields = {}) => emit('error', service, agentId, event, fields),
    time: (event, extraFields = {}) => {
      const start = Date.now();
      return () => {
        const durationMs = Date.now() - start;
        emit('info', service, agentId, event, { ...extraFields, duration_ms: durationMs });
        return durationMs;
      };
    },
  };
}
