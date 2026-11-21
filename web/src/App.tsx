import { useEffect, useRef, useState } from "react";
import type { ActionCard, CallResult, GroceryLine, Household } from "../../src/contracts.ts";

const HOUSEHOLD = "h1";
// The API adds a per-action status to every call (CallResult itself is frozen).
type ActionStatus = "pending" | "approved" | "answered";
type Call = CallResult & { status: Record<string, ActionStatus> };
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}
const postJson = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function App() {
  const [calls, setCalls] = useState<Call[]>([]); // oldest first
  const [household, setHousehold] = useState<Household | null>(null);
  const [busy, setBusy] = useState(false);
  // The call in flight: shown at once as Lakshmi's bubble with a spinner, replaced by the real call on reply.
  const [sending, setSending] = useState<{ text: string; t0: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [base, setBase] = useState<Record<string, CallResult>>({}); // callId → plain run; not stored server-side, gone on reload
  const thread = useRef<HTMLDivElement>(null);

  const refreshHousehold = () => api<Household>(`/households/${HOUSEHOLD}`).then(setHousehold);
  const refreshCall = async (callId: string) => {
    const fresh = await api<Call>(`/calls/${callId}`);
    setCalls((cs) => cs.map((c) => (c.callId === callId ? fresh : c)));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setSending(null);
    }
  };

  const load = () =>
    run(async () => {
      const [list] = await Promise.all([api<Call[]>(`/calls?householdId=${HOUSEHOLD}`), refreshHousehold()]);
      setCalls(list.reverse());
    });
  useEffect(() => void load(), []);
  // Only new or in-flight calls scroll; approving a card higher up keeps your place.
  // Scroll the thread itself: scrollIntoView would also scroll the phone layout's page past the thread.
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  }, [calls.length, sending, Object.keys(base).length]);

  const addCall = (text: string, init: RequestInit) => {
    setSending({ text, t0: Date.now() });
    return run(async () => {
      // Same note, in parallel, through the base model (no household memory). Its failure never blocks the real call.
      const plain = compare
        ? api<CallResult>(`/calls?householdId=${HOUSEHOLD}&mode=plain`, { method: "POST", ...init })
          .catch((e: Error) => void setError(`Base model: ${e.message}`))
        : undefined;
      const call = await api<Call>(`/calls?householdId=${HOUSEHOLD}`, { method: "POST", ...init });
      setCalls((cs) => [...cs, call]);
      void plain?.then((b) => b && setBase((m) => ({ ...m, [call.callId]: b })));
    });
  };
  const sendAudio = (blob: Blob, type: string, label: string) =>
    addCall(label, { headers: { "content-type": type }, body: blob });
  const sendText = (transcript: string) =>
    addCall(transcript, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdId: HOUSEHOLD, transcript }),
    });

  const approve = (callId: string, card: ActionCard) =>
    run(async () => {
      await api(`/actions/${card.id}/approve`, { method: "POST" });
      await Promise.all([refreshCall(callId), refreshHousehold()]);
    });
  const answer = (callId: string, card: ActionCard, option: string) =>
    run(async () => {
      await postJson(`/actions/${card.id}/answer`, { option });
      await refreshCall(callId); // the cart card is updated (or created) server-side
    });

  const reset = () =>
    run(async () => {
      await api(`/households/${HOUSEHOLD}/reset`, { method: "POST" });
      await load();
    });

  return (
    <div className="layout">
      <main>
        <header>
          <h1>Lakshmi</h1>
          <span className="muted">cook · household {HOUSEHOLD}</span>
        </header>
        <div className="thread" ref={thread}>
          {calls.length === 0 && !sending && <p className="muted center">No calls yet. Record, upload or type a note below.</p>}
          {calls.map((call) => (
            <CallView key={call.callId} call={call} base={base[call.callId]} household={household}
              onApprove={(c) => approve(call.callId, c)} onAnswer={(c, o) => answer(call.callId, c, o)} />
          ))}
          {sending && <Sending {...sending} />}
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <Composer busy={busy} compare={compare} onCompare={setCompare} onAudio={sendAudio} onText={sendText} onError={setError} />
      </main>
      <Memory household={household} busy={busy} onReset={reset} />
    </div>
  );
}

function Sending({ text, t0 }: { text: string; t0: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <section className="call">
      <div className="bubble cook">{text}</div>
      <span className="chip pending" role="status">
        <span className="spinner" aria-hidden /> working… {((now - t0) / 1000).toFixed(1)} s
      </span>
    </section>
  );
}

function CallView({ call, base, household, onApprove, onAnswer }: {
  call: Call;
  base: CallResult | undefined;
  household: Household | null;
  onApprove: (card: ActionCard) => void;
  onAnswer: (card: ActionCard, option: string) => void;
}) {
  const t = call.timings;
  return (
    <section className="call">
      <div className="bubble cook">
        <div className="meta">{call.transcript.lang} · {call.transcript.provider}</div>
        {call.transcript.text}
      </div>
      <div className="reply">
        {call.extraction.notes.length > 0 && (
          <ul className="notes">{call.extraction.notes.map((n, i) => <li key={i}>📝 {n}</li>)}</ul>
        )}
        {call.actions.map((card) => (
          <Card key={card.id} card={card} limit={household?.approvalLimit} status={call.status[card.id]}
            onApprove={() => onApprove(card)} onAnswer={(o) => onAnswer(card, o)} />
        ))}
        <Latency call={call} />
        {base && <BaseModel ours={call} base={base} />}
      </div>
    </section>
  );
}

function Latency({ call: { timings: t } }: { call: CallResult }) {
  return (
    <span className="chip" title="agent response latency">
      {Math.round(t.totalMs)} ms · stt {Math.round(t.sttMs)} · extract {Math.round(t.extractMs)} · plan {Math.round(t.planMs)}
    </span>
  );
}

// Read-only plain-LLM run of the same note; tags mark where it differs from ours.
function BaseModel({ ours, base }: { ours: CallResult; base: CallResult }) {
  const mine = new Map(ours.extraction.groceries.map((l) => [l.item, l]));
  const theirs = new Map(base.extraction.groceries.map((l) => [l.item, l]));
  const amount = (l: GroceryLine) => `${l.qty} ${l.unit}`;
  return (
    <div className="card base">
      <h3>Base model <span className="muted">· no household memory · read-only</span></h3>
      <p className="muted">“{base.transcript.text}”</p>
      <table>
        <tbody>
          {[...new Set([...mine.keys(), ...theirs.keys()])].map((item) => {
            const o = mine.get(item), b = theirs.get(item);
            const diffs = !b ? ["missed"] : !o ? ["not in ours"] : [
              amount(o) !== amount(b) && `ours ${amount(o)}`,
              o.brand !== b.brand && `ours ${o.brand ?? "no brand"}`,
            ].filter((d) => d !== false);
            return (
              <tr key={item}>
                <td>{item}</td>
                <td>{b ? amount(b) : "—"}</td>
                <td>{b?.brand ?? "—"}</td>
                <td>{diffs.map((d) => <span key={d} className="badge warn">{d}</span>)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Latency call={base} />
    </div>
  );
}

function Card({ card, limit, status, onApprove, onAnswer }: {
  card: ActionCard;
  limit: number | undefined;
  status: ActionStatus | undefined;
  onApprove: () => void;
  onAnswer: (option: string) => void;
}) {
  const done = status !== undefined && status !== "pending";
  if (card.type === "cart") {
    const { cart } = card;
    return (
      <div className="card">
        <h3>Cart <span className="muted">· {cart.platform}</span></h3>
        <table>
          <tbody>
            {cart.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.item}</td>
                <td>{l.qty} {l.unit}</td>
                <td className="muted">{l.brand ?? "—"}</td>
                <td className="num">{rupees(l.price)}</td>
                <td><a href={l.searchUrl} target="_blank" rel="noreferrer">search</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <strong>Total {rupees(cart.total)}</strong>
          <span className={card.needsApproval ? "badge warn" : "badge ok"}>
            {card.needsApproval ? "needs approval" : "within limit"}{limit !== undefined && ` (${rupees(limit)})`}
          </span>
          {cart.checkoutUrl && <a href={cart.checkoutUrl} target="_blank" rel="noreferrer">checkout</a>}
          <button onClick={onApprove} disabled={done}>{done ? "Approved ✓" : "Approve"}</button>
        </div>
      </div>
    );
  }
  if (card.type === "advance") {
    return (
      <div className="card">
        <h3>Advance {rupees(card.advance.amount)}</h3>
        <p>{card.advance.reason ?? "No reason given"} · to <strong>{card.payee}</strong></p>
        {done ? (
          card.upiUrl ? <p><a className="upi" href={card.upiUrl}>Pay via UPI</a> <code>{card.upiUrl}</code></p> : <p>Approved ✓</p>
        ) : (
          <button onClick={onApprove}>Approve</button>
        )}
      </div>
    );
  }
  return (
    <div className="card">
      <h3>❓ {card.text}</h3>
      <div className="options">
        {card.options.map((o) => (
          <button key={o} onClick={() => onAnswer(o)} disabled={done}>{o}</button>
        ))}
        {done && <span className="muted">Answered ✓</span>}
      </div>
    </div>
  );
}

function Composer({ busy, compare, onCompare, onAudio, onText, onError }: {
  busy: boolean;
  compare: boolean;
  onCompare: (on: boolean) => void;
  onAudio: (blob: Blob, type: string, label: string) => void;
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const rec = useRef<{ r: MediaRecorder; t0: number } | null>(null);

  const stop = () => {
    rec.current?.r.stop();
    rec.current = null;
    setRecording(false);
  };
  // Hold to talk (release sends), or tap once to start and tap again to send.
  const down = async () => {
    if (rec.current) return stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Safari has no webm recording; the server maps audio/mp4 → .m4a.
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/mp4";
    const r = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      onAudio(new Blob(chunks, { type: r.mimeType }), r.mimeType, `🎤 Voice note · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    };
    const t0 = Date.now();
    r.start();
    rec.current = { r, t0 };
    setRecording(true);
  };
  const up = () => {
    if (rec.current && Date.now() - rec.current.t0 > 400) stop();
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    // Express only parses audio/* as raw; an empty or video/* type would hit the JSON branch.
    const type = file.type.startsWith("audio/") ? file.type : `audio/${file.name.split(".").pop() ?? "mpeg"}`;
    onAudio(file, type, `📎 ${file.name}`);
  };

  return (
    <form className="composer" onSubmit={(e) => {
      e.preventDefault();
      if (text.trim()) onText(text.trim());
      setText("");
    }}>
      <button type="button" className={recording ? "mic on" : "mic"} disabled={busy && !recording}
        onPointerDown={() => down().catch((e: Error) => onError(`Mic: ${e.message}`))} onPointerUp={up} aria-label={recording ? "Stop recording" : "Record"}>
        {recording ? "■" : "🎤"}
      </button>
      <label className="file">
        📎<input type="file" accept="audio/*" disabled={busy} onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = "";
        }} />
      </label>
      <input className="text" placeholder="Or type what Lakshmi said…" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={busy || !text.trim()}>Send</button>
      <label className="compare" title="Also send the note to the base model (no household memory) and show the difference">
        <input type="checkbox" checked={compare} onChange={(e) => onCompare(e.target.checked)} /> <span className="long">Compare with </span>base model
      </label>
    </form>
  );
}

function Memory({ household: h, busy, onReset }: { household: Household | null; busy: boolean; onReset: () => void }) {
  if (!h) return <aside />;
  return (
    <aside>
      <div className="row">
        <h2>Household memory</h2>
        <button className="small" onClick={onReset} disabled={busy}>Reset demo</button>
      </div>
      <dl>
        <dt>Cook</dt><dd>{h.cook.name} · {h.cook.lang} · {h.cook.upiId}</dd>
        <dt>Approval limit</dt><dd>{rupees(h.approvalLimit)}</dd>
        <dt>Family</dt><dd>{h.family.headcount} people{h.family.dietRules.map((r) => <div key={r} className="muted">{r}</div>)}</dd>
      </dl>
      <h3>Brands</h3>
      <ul>{Object.entries(h.brands).map(([item, brand]) => <li key={item}>{item}: <strong>{brand}</strong></li>)}</ul>
      <h3>Pantry</h3>
      <ul>{Object.entries(h.pantry).map(([item, p]) => <li key={item}>{item}: {p.qty} {p.unit}</li>)}</ul>
      <h3>History</h3>
      <ul>
        {[...h.history].reverse().map((e, i) => (
          <li key={i}><span className="muted">{e.at}</span> {e.lines.map((l) => `${l.item} ${l.qty}${l.unit}`).join(", ")}</li>
        ))}
      </ul>
    </aside>
  );
}
