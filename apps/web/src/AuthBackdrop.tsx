import { useEffect, useRef, useState, type RefObject } from 'react';

const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'OpenCode', 'Gemini CLI'];
const SERVERS = ['GitHub', 'Linear', 'Postgres', 'Slack', 'Sentry'];
const LEG_MS = 850;
const MAX_PACKETS = 5;
// Small per-row offsets so the columns read as scattered, not ruled.
const JITTER = [0.08, -0.06, 0.04, -0.08, 0.06];

type Side = 'agent' | 'server';
// (x, y) is where the chip meets its wire; (px, py) is the port on the card edge.
type Node = { label: string; side: Side; x: number; y: number; px: number; py: number; depth: number; phase: number };
// Each leg runs along one wire; `reverse` means card → chip.
type Packet = { legs: [wire: number, reverse: boolean][]; leg: number; start: number; el: SVGCircleElement };

function layout(root: HTMLElement, card: HTMLElement): Node[] | null {
  const r = root.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const left = c.left - r.left;
  const right = c.right - r.left;
  const cy = c.top - r.top + c.height / 2;
  const room = Math.min(left, r.width - right);
  const spread = Math.min(c.height * 0.75, cy - 80, r.height - cy - 80);
  if (room < 320 || spread < 100) return null;
  const reach = Math.min(room - 150, 320);
  const place = (labels: string[], side: Side) =>
    labels.map((label, i): Node => {
      const t = (i / (labels.length - 1)) * 2 - 1;
      const dx = reach * (0.6 + 0.4 * Math.cos((t * Math.PI) / 2) + JITTER[i]!);
      return {
        label,
        side,
        x: side === 'agent' ? left - dx : right + dx,
        y: cy + t * spread,
        px: side === 'agent' ? left : right,
        py: cy + t * 14,
        depth: 0.5 + ((i * 3) % 5) / 8,
        phase: i * 1.7 + (side === 'server' ? 0.9 : 0),
      };
    });
  return [...place(AGENTS, 'agent'), ...place(SERVERS, 'server')];
}

const wire = (x: number, y: number, n: Node) => {
  const mx = (x + n.px) / 2;
  return `M${x} ${y}C${mx} ${y} ${mx} ${n.py} ${n.px} ${n.py}`;
};

const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

function hit(el: Element | null | undefined) {
  if (!el) return;
  el.classList.remove('hit');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('hit');
}

/** Decorative auth-page background: a pointer-lit grid, plus agents on the left and MCP servers on the right trading packets through the card. */
export function AuthBackdrop({ cardRef }: { cardRef: RefObject<HTMLElement | null> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const packetLayer = useRef<SVGGElement>(null);
  const nodeEls = useRef<(HTMLDivElement | null)[]>([]);
  const wireEls = useRef<(SVGPathElement | null)[]>([]);
  const touch = useRef<(i: number) => void>(() => {});
  const [nodes, setNodes] = useState<Node[] | null>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const card = cardRef.current;
    const move = (e: PointerEvent) => {
      const r = root.getBoundingClientRect();
      root.style.setProperty('--mx', `${e.clientX - r.left}px`);
      root.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    window.addEventListener('pointermove', move);
    const ro = card && new ResizeObserver(() => setNodes(layout(root, card)));
    ro?.observe(root);
    if (card) ro?.observe(card);
    return () => {
      window.removeEventListener('pointermove', move);
      ro?.disconnect();
    };
  }, [cardRef]);

  useEffect(() => {
    if (!nodes || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const agents = nodes.flatMap((n, i) => (n.side === 'agent' ? [i] : []));
    const servers = nodes.flatMap((n, i) => (n.side === 'server' ? [i] : []));
    const pick = (a: number[]) => a[Math.floor(Math.random() * a.length)]!;
    const live = nodes.map(() => 0);
    const packets: Packet[] = [];
    const target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    const lastTouch = nodes.map(() => 0);

    const setLive = (w: number, d: number) => {
      live[w]! += d;
      wireEls.current[w]?.classList.toggle('wire-live', live[w]! > 0);
    };

    const spawn = (agent = pick(agents), server = pick(servers)) => {
      if (document.hidden || packets.length >= MAX_PACKETS || !packetLayer.current) return;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      el.setAttribute('r', '3.5');
      el.setAttribute('class', 'packet');
      packetLayer.current.append(el);
      packets.push({ legs: [[agent, false], [server, true], [server, false], [agent, true]], leg: 0, start: performance.now(), el });
      setLive(agent, 1);
    };

    touch.current = (i) => {
      const now = performance.now();
      if (now - lastTouch[i]! < 600) return;
      lastTouch[i] = now;
      if (nodes[i]!.side === 'agent') spawn(i);
      else spawn(undefined, i);
    };

    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / innerWidth) * 2 - 1;
      target.y = (e.clientY / innerHeight) * 2 - 1;
    };

    const frame = (now: number) => {
      cur.x += (target.x - cur.x) * 0.05;
      cur.y += (target.y - cur.y) * 0.05;
      nodes.forEach((n, i) => {
        const x = n.x - cur.x * n.depth * 16 + Math.sin(now / 1900 + n.phase) * 3;
        const y = n.y - cur.y * n.depth * 16 + Math.cos(now / 2300 + n.phase) * 5;
        nodeEls.current[i]?.style.setProperty('translate', `${x}px ${y}px`);
        wireEls.current[i]?.setAttribute('d', wire(x, y, n));
      });

      for (let q = packets.length - 1; q >= 0; q--) {
        const p = packets[q]!;
        let k = (now - p.start) / LEG_MS;
        if (k >= 1) {
          const [done] = p.legs[p.leg]!;
          setLive(done, -1);
          // Even legs end at the card, odd legs at a chip.
          hit(p.leg % 2 === 0 ? cardRef.current : nodeEls.current[done]);
          p.leg++;
          p.start = now;
          k = 0;
          if (p.leg === p.legs.length) {
            p.el.remove();
            packets.splice(q, 1);
            continue;
          }
          setLive(p.legs[p.leg]![0], 1);
          if (p.leg === 2) p.el.classList.add('packet-reply');
        }
        const [w, reverse] = p.legs[p.leg]!;
        const path = wireEls.current[w];
        if (!path) continue;
        const len = path.getTotalLength();
        const pt = path.getPointAtLength(len * (reverse ? 1 - ease(k) : ease(k)));
        p.el.setAttribute('cx', `${pt.x}`);
        p.el.setAttribute('cy', `${pt.y}`);
      }
      raf = requestAnimationFrame(frame);
    };

    let raf = requestAnimationFrame(frame);
    const timer = setInterval(() => spawn(), 1400);
    spawn();
    window.addEventListener('pointermove', onMove);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      window.removeEventListener('pointermove', onMove);
      packets.forEach((p) => p.el.remove());
      wireEls.current.forEach((el) => el?.classList.remove('wire-live'));
      touch.current = () => {};
    };
  }, [nodes, cardRef]);

  const firstServer = AGENTS.length;

  return (
    <div className="backdrop" ref={rootRef} aria-hidden="true">
      <div className="backdrop-grid" />
      <div className="backdrop-grid backdrop-grid-lit" />
      {nodes && (
        <>
          <svg className="net">
            {nodes.map((n, i) => (
              <path key={n.label} ref={(el) => void (wireEls.current[i] = el)} className="wire" d={wire(n.x, n.y, n)} />
            ))}
            <g ref={packetLayer} />
          </svg>
          <p className="net-caption net-caption-agent" style={{ translate: `${nodes[0]!.x}px ${nodes[0]!.y - 40}px` }}>
            Your agents
          </p>
          <p className="net-caption" style={{ translate: `${nodes[firstServer]!.x}px ${nodes[firstServer]!.y - 40}px` }}>
            Your MCP servers
          </p>
          {nodes.map((n, i) => (
            <div
              key={n.label}
              ref={(el) => void (nodeEls.current[i] = el)}
              className={`node node-${n.side}`}
              style={{ translate: `${n.x}px ${n.y}px` }}
              onPointerEnter={() => touch.current(i)}
            >
              <span className="node-dot" />
              {n.label}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
