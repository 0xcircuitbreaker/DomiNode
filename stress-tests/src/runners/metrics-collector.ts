import http from "node:http";
import pg from "pg";

const { Pool } = pg;

export interface InternalStats {
  activeSessions: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
}

export interface ProcessMetrics {
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  timestamp: number;
}

export interface DbMetrics {
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
}

export interface CollectedMetrics {
  timestamp: number;
  internal: InternalStats | null;
  process: ProcessMetrics;
  db: DbMetrics | null;
}

export class MetricsCollector {
  private readonly statsUrl: string;
  private readonly statsToken: string;
  private readonly dbPool: InstanceType<typeof Pool> | null;
  private snapshots: CollectedMetrics[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(statsUrl: string, statsToken: string, databaseUrl: string) {
    this.statsUrl = statsUrl;
    this.statsToken = statsToken;
    this.dbPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;
  }

  /**
   * Start polling metrics at the given interval.
   */
  start(intervalMs: number = 1000): void {
    this.snapshots = [];
    this.collect(); // immediate first snapshot
    this.interval = setInterval(() => this.collect(), intervalMs);
  }

  /**
   * Stop polling and release resources.
   */
  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.dbPool) {
      await this.dbPool.end();
    }
  }

  /**
   * Get all collected snapshots.
   */
  getSnapshots(): CollectedMetrics[] {
    return [...this.snapshots];
  }

  /**
   * Get summary statistics from collected data.
   */
  getSummary(): {
    peakActiveSessions: number;
    peakHeapMb: number;
    heapGrowthMb: number;
    avgLatencyMs: number;
    totalSnapshots: number;
    durationMs: number;
  } {
    if (this.snapshots.length === 0) {
      return {
        peakActiveSessions: 0,
        peakHeapMb: 0,
        heapGrowthMb: 0,
        avgLatencyMs: 0,
        totalSnapshots: 0,
        durationMs: 0,
      };
    }

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];

    let peakSessions = 0;
    let peakHeap = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const snap of this.snapshots) {
      if (snap.internal) {
        peakSessions = Math.max(peakSessions, snap.internal.activeSessions);
        if (snap.internal.avgLatencyMs > 0) {
          latencySum += snap.internal.avgLatencyMs;
          latencyCount++;
        }
      }
      peakHeap = Math.max(peakHeap, snap.process.heapUsedMb);
    }

    return {
      peakActiveSessions: peakSessions,
      peakHeapMb: Math.round(peakHeap * 100) / 100,
      heapGrowthMb: Math.round((last.process.heapUsedMb - first.process.heapUsedMb) * 100) / 100,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
      totalSnapshots: this.snapshots.length,
      durationMs: last.timestamp - first.timestamp,
    };
  }

  private async collect(): Promise<void> {
    const [internal, db] = await Promise.all([
      this.fetchInternalStats(),
      this.fetchDbMetrics(),
    ]);

    const mem = process.memoryUsage();
    const processMetrics: ProcessMetrics = {
      heapUsedMb: mem.heapUsed / 1_048_576,
      heapTotalMb: mem.heapTotal / 1_048_576,
      rssMb: mem.rss / 1_048_576,
      timestamp: Date.now(),
    };

    this.snapshots.push({
      timestamp: Date.now(),
      internal,
      process: processMetrics,
      db,
    });
  }

  private fetchInternalStats(): Promise<InternalStats | null> {
    return new Promise((resolve) => {
      const url = new URL(this.statsUrl);

      const req = http.get(
        {
          hostname: url.hostname,
          port: url.port || 8080,
          path: url.pathname,
          headers: {
            Authorization: `Bearer ${this.statsToken}`,
          },
          timeout: 2000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              resolve({
                activeSessions: data.activeSessions ?? 0,
                totalRequests: data.totalRequests ?? 0,
                totalErrors: data.totalErrors ?? 0,
                avgLatencyMs: data.avgLatencyMs ?? 0,
              });
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  private async fetchDbMetrics(): Promise<DbMetrics | null> {
    if (!this.dbPool) return null;

    try {
      const result = await this.dbPool.query(`
        SELECT
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'idle') as idle,
          count(*) FILTER (WHERE wait_event IS NOT NULL AND state != 'idle') as waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);

      const row = result.rows[0];
      return {
        activeConnections: parseInt(row.active, 10),
        idleConnections: parseInt(row.idle, 10),
        waitingConnections: parseInt(row.waiting, 10),
      };
    } catch {
      return null;
    }
  }
}
