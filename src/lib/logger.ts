export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
  details?: any;
}

class Logger {
  private logs: LogEntry[] = [];
  private listeners: ((logs: LogEntry[]) => void)[] = [];
  private nextId = 1;

  private addLog(level: LogLevel, message: string, details?: any) {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level,
      message,
      details,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 2000) {
      this.logs.pop();
    }
    this.notify();

    if (level === 'error') console.error(`[STREAM] ${message}`, details || '');
    else if (level === 'warn') console.warn(`[STREAM] ${message}`, details || '');
    else console.log(`[STREAM] ${message}`, details || '');
  }

  info(message: string, details?: any) { this.addLog('info', message, details); }
  warn(message: string, details?: any) { this.addLog('warn', message, details); }
  error(message: string, details?: any) { this.addLog('error', message, details); }

  subscribe(listener: (logs: LogEntry[]) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this.notify();
  }

  private notify() {
    this.listeners.forEach(l => l([...this.logs]));
  }
}

export const logger = new Logger();
