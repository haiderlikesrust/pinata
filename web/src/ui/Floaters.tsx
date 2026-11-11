import { useStore } from '../store';

/** Damage and heal numbers that pop off the piñata. */
export function Floaters() {
  const floaters = useStore((s) => s.floaters);
  const drop = useStore((s) => s.dropFloater);
  return (
    <div className="floaters" aria-hidden>
      {floaters.map((f) => (
        <div key={f.id} className={`floater ${f.kind}`} style={{ left: `${f.x}%`, top: `${f.y}%` }} onAnimationEnd={() => drop(f.id)}>
          <b>{f.text}</b>
          <span>{f.sub}</span>
        </div>
      ))}
    </div>
  );
}
