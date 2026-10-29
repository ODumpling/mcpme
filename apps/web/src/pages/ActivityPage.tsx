import { useEffect, useState } from 'react';
import { api, type AuditEntry } from '../api.ts';

const statusLabel = { ok: 'OK', error: 'Error', blocked: 'Blocked' };

export function ActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    const load = () => api<{ entries: AuditEntry[] }>('/audit').then((r) => setEntries(r.entries));
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <h1>Activity</h1>
      <p className="muted">The last 200 calls through MCPME. Arguments and results aren't stored.</p>
      {entries?.length === 0 && (
        <div className="card empty">
          <p className="muted">No calls yet.</p>
        </div>
      )}
      {entries && entries.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Call</th>
                <th>Result</th>
                <th className="cell-end">Time</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{new Date(e.createdAt).toLocaleString()}</td>
                  <td>
                    <code>{e.target}</code> <span className="muted">{e.method}</span>
                  </td>
                  <td>
                    <span className={`badge badge-${e.status === 'ok' ? 'connected' : e.status === 'blocked' ? 'needs_auth' : 'error'}`}>
                      <span className="dot" aria-hidden />
                      {statusLabel[e.status]}
                    </span>
                    {e.error && <div className="muted clamp">{e.error}</div>}
                  </td>
                  <td className="cell-end tabular nowrap">{e.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
