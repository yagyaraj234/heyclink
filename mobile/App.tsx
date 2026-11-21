import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import type { ActionCard, CallResult, Cart, Diet, Goal, Lang, Macros, MealChoice, Order, Weekday } from "../src/contracts.ts";

// The API runs on the same machine as the Expo dev server, so default to its LAN host on :3000.
const API = process.env.EXPO_PUBLIC_API_URL ?? `http://${(Constants.expoConfig?.hostUri ?? "localhost").split(":")[0]}:3000`;
// The seeded demo household, for skipping signup/join.
const DEMO_HOUSEHOLD = "h1";

type ActionStatus = "pending" | "approved" | "answered";
type Call = CallResult & { status: Record<string, ActionStatus> };
type Role = "owner" | "cook";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body as T;
}
const postJson = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export default function App() {
  const [role, setRole] = useState<Role | null>(null);
  // Kept per role so one phone can demo signup on the owner side and join on the cook side.
  const [ownerHouse, setOwnerHouse] = useState<string | null>(null);
  const [cookHouse, setCookHouse] = useState<string | null>(null);
  return (
    <View style={s.screen}>
      <StatusBar style="dark" />
      <View style={s.header}>
        <Text style={s.title}>{role === "cook" ? "रसोई" : "Kitchen"}</Text>
        {role && (
          <Pressable onPress={() => setRole(role === "owner" ? "cook" : "owner")} style={s.chipBtn}>
            <Text style={s.chipText}>{role === "owner" ? "Switch to cook" : "Switch to owner"}</Text>
          </Pressable>
        )}
      </View>
      {role === null && <RolePick onPick={setRole} />}
      {role === "cook" && (cookHouse ? <Cook householdId={cookHouse} /> : <Join onJoin={setCookHouse} />)}
      {role === "owner" && (ownerHouse ? <Owner householdId={ownerHouse} /> : <Signup onDone={setOwnerHouse} />)}
    </View>
  );
}

function RolePick({ onPick }: { onPick: (r: Role) => void }) {
  return (
    <View style={s.center}>
      <Text style={s.h2}>Who is using this phone?</Text>
      <Pressable style={s.bigBtn} onPress={() => onPick("owner")}><Text style={s.bigBtnText}>I run the house</Text></Pressable>
      <Pressable style={s.bigBtn} onPress={() => onPick("cook")}><Text style={s.bigBtnText}>मैं खाना बनाती/बनाता हूँ</Text></Pressable>
    </View>
  );
}

// ---- Signup (owner) and join (cook) ----------------------------------------

const DAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function Choice<T extends string>({ options, value, onChange, multi }: {
  options: readonly T[];
  value: T | T[];
  onChange: (v: T) => void;
  multi?: boolean;
}) {
  return (
    <View style={s.options}>
      {options.map((o) => {
        const on = multi ? (value as T[]).includes(o) : value === o;
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={[s.seg, on && s.segOn]}>
            <Text style={[s.segText, on && s.segTextOn]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} {...props} />
    </View>
  );
}

function Signup({ onDone }: { onDone: (householdId: string) => void }) {
  const [f, setF] = useState({ ownerName: "", ownerPhone: "", cookName: "", upiId: "", salary: "", limit: "500", protein: "" });
  const [lang, setLang] = useState<Lang>("hi");
  const [offDays, setOffDays] = useState<Weekday[]>([]);
  const [goal, setGoal] = useState<Goal>("maintain");
  const [diet, setDiet] = useState<Diet>("veg");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; code: string } | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const num = (v: string) => Number(v.replace(/[^\d.]/g, "")) || 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id, cookCode } = await postJson<{ id: string; cookCode: string }>("/households", {
        owner: { name: f.ownerName.trim(), phone: f.ownerPhone.trim() },
        cook: { name: f.cookName.trim(), lang, upiId: f.upiId.trim(), monthlySalary: num(f.salary), offDays },
        approvalLimit: num(f.limit),
        goals: { goal, diet, ...(f.protein ? { proteinG: num(f.protein) } : {}) },
      });
      setDone({ id, code: cookCode });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <View style={s.center}>
        <Text style={s.h2}>Give this to {f.cookName.trim() || "your cook"}</Text>
        <Text style={s.code} selectable>{done.code}</Text>
        <Text style={[s.muted, s.centerText]}>They enter it on the cook side of the app.</Text>
        <Pressable style={s.bigBtn} onPress={() => onDone(done.id)}><Text style={s.bigBtnText}>Go to the feed</Text></Pressable>
      </View>
    );
  }
  const ready = f.ownerName.trim() && f.cookName.trim() && f.upiId.trim();
  return (
    <ScrollView contentContainerStyle={s.form} keyboardShouldPersistTaps="handled">
      <Text style={s.h3}>You</Text>
      <Field label="Name" value={f.ownerName} onChangeText={set("ownerName")} />
      <Field label="Phone" value={f.ownerPhone} onChangeText={set("ownerPhone")} keyboardType="phone-pad" />
      <Text style={s.h3}>Your cook</Text>
      <Field label="Name" value={f.cookName} onChangeText={set("cookName")} placeholder="Lakshmi" />
      <Text style={s.label}>Language</Text>
      <Choice options={["hi", "te", "en"] as const} value={lang} onChange={setLang} />
      <Field label="UPI id" value={f.upiId} onChangeText={set("upiId")} autoCapitalize="none" placeholder="name@okaxis" />
      <Field label="Monthly salary (₹)" value={f.salary} onChangeText={set("salary")} keyboardType="number-pad" />
      <Text style={s.label}>Off days</Text>
      <Choice multi options={DAYS} value={offDays}
        onChange={(d) => setOffDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]))} />
      <Text style={s.h3}>Kitchen</Text>
      <Field label="Approve carts above (₹)" value={f.limit} onChangeText={set("limit")} keyboardType="number-pad" />
      <Text style={s.label}>Goal</Text>
      <Choice options={["lose", "maintain", "gain"] as const} value={goal} onChange={setGoal} />
      <Text style={s.label}>Diet</Text>
      <Choice options={["veg", "egg", "non-veg"] as const} value={diet} onChange={setDiet} />
      <Field label="Protein target (g/day, optional)" value={f.protein} onChangeText={set("protein")} keyboardType="number-pad" />
      {error && <Text style={s.error}>{error}</Text>}
      <Pressable style={[s.bigBtn, (!ready || busy) && s.disabled]} disabled={!ready || busy} onPress={submit}>
        <Text style={s.bigBtnText}>{busy ? "…" : "Sign up"}</Text>
      </Pressable>
      <Pressable onPress={() => onDone(DEMO_HOUSEHOLD)}><Text style={[s.link, s.centerText]}>Use the demo household</Text></Pressable>
    </ScrollView>
  );
}

function Join({ onJoin }: { onJoin: (householdId: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { householdId } = await postJson<{ householdId: string }>("/join", { code: code.trim().toUpperCase() });
      onJoin(householdId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={s.center}>
      <Text style={s.h2}>मालिक से मिला कोड डालें</Text>
      <TextInput style={[s.input, s.codeInput]} value={code} onChangeText={setCode} maxLength={6}
        autoCapitalize="characters" autoCorrect={false} placeholder="ABC123" />
      {error && <Text style={[s.error, s.centerText]}>{error}</Text>}
      <Pressable style={[s.bigBtn, (code.trim().length !== 6 || busy) && s.disabled]} disabled={code.trim().length !== 6 || busy} onPress={join}>
        <Text style={s.bigBtnText}>{busy ? "…" : "जुड़ें"}</Text>
      </Pressable>
      <Pressable onPress={() => onJoin(DEMO_HOUSEHOLD)}><Text style={[s.link, s.centerText]}>डेमो घर इस्तेमाल करें</Text></Pressable>
    </View>
  );
}

// ---- Cook: hold to record, or type; both go to POST /calls --------------------

function Cook({ householdId }: { householdId: string }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY); // .m4a (AAC) on iOS and Android
  const [recording, setRecording] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestRecordingPermissionsAsync()
      .then((p) => (p.granted ? setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }) : setError("माइक की अनुमति नहीं मिली")))
      .catch((e: Error) => setError(e.message));
  }, []);

  const send = async (init: RequestInit) => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const call = await api<CallResult>(`/calls?householdId=${householdId}`, { method: "POST", ...init });
      setSent(call.transcript.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Refs, not state: a quick tap can release before prepare finishes, and stop must see that.
  const held = useRef(false);
  const startedAt = useRef(0);
  const start = async () => {
    held.current = true;
    setError(null);
    try {
      await recorder.prepareToRecordAsync();
      if (!held.current) return; // released while preparing; don't leave the mic on
      recorder.record();
      startedAt.current = Date.now();
      setRecording(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stop = async () => {
    held.current = false;
    if (!startedAt.current) return;
    const ms = Date.now() - startedAt.current;
    startedAt.current = 0;
    setRecording(false);
    await recorder.stop();
    if (ms < 500) return setError("थोड़ा देर तक दबाकर रखें");
    if (!recorder.uri) return setError("रिकॉर्डिंग नहीं मिली");
    // The server takes the raw bytes; audio/mp4 maps to .m4a for the STT provider.
    const blob = await (await fetch(recorder.uri)).blob();
    await send({ headers: { "content-type": "audio/mp4" }, body: blob });
  };

  return (
    <ScrollView contentContainerStyle={s.cook} keyboardShouldPersistTaps="handled">
      <Text style={s.h2}>दीदी/भैया को बताइए क्या चाहिए</Text>
      <Pressable onPressIn={start} onPressOut={stop} disabled={busy}
        style={[s.mic, recording && s.micOn, busy && s.disabled]} accessibilityLabel="दबाकर बोलें">
        <Text style={s.micIcon}>{recording ? "●" : "🎤"}</Text>
      </Pressable>
      <Text style={s.muted}>{recording ? "बोलिए… छोड़ते ही भेज देंगे" : "दबाकर रखें और बोलें"}</Text>
      <View style={s.row}>
        <TextInput style={s.input} placeholder="या यहाँ लिखें…" value={text} onChangeText={setText} editable={!busy} />
        <Pressable style={[s.btn, (busy || !text.trim()) && s.disabled]} disabled={busy || !text.trim()} onPress={() => {
          void send({ headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId, transcript: text.trim() }) });
          setText("");
        }}>
          <Text style={s.btnText}>भेजें</Text>
        </Pressable>
      </View>
      {busy && <ActivityIndicator style={{ marginTop: 16 }} />}
      {sent !== null && (
        <View style={s.card}>
          <Text style={s.ok}>भेज दिया ✓</Text>
          <Text style={s.body}>{sent}</Text>
        </View>
      )}
      {error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

// ---- Owner: poll the calls and act on cards ---------------------------------

function Owner({ householdId }: { householdId: string }) {
  const [calls, setCalls] = useState<Call[]>([]); // newest first, as the server returns them
  const [errors, setErrors] = useState<Record<string, string>>({}); // card id (or "feed") → message
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  // ponytail: meal plans and their carts aren't tied to a call, so GET /calls never returns them. Held here
  // (newest first) until reload; poll GET /households/:id/actions once actions ships it.
  const [loose, setLoose] = useState<{ card: ActionCard; status: ActionStatus }[]>([]);
  const settle = (id: string, status: ActionStatus) => setLoose((l) => l.map((x) => (x.card.id === id ? { ...x, status } : x)));

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setCalls(await api<Call[]>(`/calls?householdId=${householdId}`));
      setErrors(({ feed: _, ...rest }) => rest);
    } catch (e) {
      setErrors((m) => ({ ...m, feed: `Can't reach ${API}: ${(e as Error).message}` }));
    } finally {
      inFlight.current = false;
    }
  };
  useEffect(() => {
    void load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const act = async (card: ActionCard, fn: () => Promise<void>) => {
    setBusy(card.id);
    setErrors(({ [card.id]: _, ...rest }) => rest);
    try {
      await fn();
      await load();
    } catch (e) {
      setErrors((m) => ({ ...m, [card.id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };
  const approve = (card: ActionCard, body?: { order: string }) =>
    act(card, async () => {
      const r = await postJson<{ upiUrl?: string }>(`/actions/${card.id}/approve`, body ?? {});
      settle(card.id, "approved");
      const upi = r.upiUrl ?? (card.type === "advance" ? card.upiUrl : undefined);
      if (upi) await Linking.openURL(upi).catch(() => { throw new Error(`Approved. No UPI app opened ${upi}`); });
    });
  const answer = (card: ActionCard, option: string) =>
    act(card, async () => {
      const r = await postJson<{ cart?: ActionCard }>(`/actions/${card.id}/answer`, { option });
      settle(card.id, "answered");
      // a question's cart belongs to its call and comes back in the poll; a meal plan's "cook" cart doesn't
      const cart = r.cart;
      if (card.type === "meal-plan" && cart) setLoose((l) => [{ card: cart, status: "pending" }, ...l]);
    });

  const [planning, setPlanning] = useState(false);
  const planTomorrow = async () => {
    setPlanning(true);
    setErrors(({ plan: _, ...rest }) => rest);
    try {
      const card = await postJson<ActionCard>(`/households/${householdId}/meal-plan`, {});
      setLoose((l) => [{ card, status: "pending" }, ...l]);
    } catch (e) {
      setErrors((m) => ({ ...m, plan: `Plan tomorrow: ${(e as Error).message}` }));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.feed}>
      <Pressable style={[s.btn, s.planBtn, planning && s.disabled]} disabled={planning} onPress={planTomorrow}>
        <Text style={s.btnText}>{planning ? "Planning…" : "🍽 Plan tomorrow"}</Text>
      </Pressable>
      {errors.plan && <Text style={s.error}>{errors.plan}</Text>}
      {errors.feed && <Text style={s.error}>{errors.feed}</Text>}
      {loose.map(({ card, status }) => (
        <Card key={card.id} card={card} status={status} busy={busy === card.id} error={errors[card.id]}
          onApprove={(body) => approve(card, body)} onAnswer={(o) => answer(card, o)} />
      ))}
      {calls.length === 0 && loose.length === 0 && !errors.feed && <Text style={[s.muted, s.centerText]}>No notes from the cook yet.</Text>}
      {calls.map((call) => (
        <View key={call.callId} style={s.call}>
          <View style={s.bubble}>
            <Text style={s.meta}>{call.transcript.lang} · {call.transcript.provider} · {Math.round(call.timings.totalMs)} ms</Text>
            <Text style={s.body}>{call.transcript.text}</Text>
          </View>
          {call.extraction.notes.map((n, i) => <Text key={i} style={s.muted}>📝 {n}</Text>)}
          {call.actions.map((card) => (
            <Card key={card.id} card={card} status={call.status[card.id]} busy={busy === card.id} error={errors[card.id]}
              onApprove={(body) => approve(card, body)} onAnswer={(o) => answer(card, o)} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function Lines({ cart }: { cart: Cart }) {
  return cart.lines.map((l, i) => (
    <View key={i} style={s.line}>
      <Text style={s.lineItem}>{l.item}{l.brand ? ` · ${l.brand}` : ""}</Text>
      <Text style={s.muted}>{l.qty} {l.unit}</Text>
      <Text style={s.price}>{rupees(l.price)}</Text>
    </View>
  ));
}

function tomorrowAt8() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function orderStatus(o: Order) {
  if (o.status === "scheduled") return o.scheduledFor ? `Scheduled for ${when(o.scheduledFor)}` : "Scheduled";
  if (o.status === "placed") return `Placed${o.orderId ? ` · #${o.orderId}` : ""}`;
  return o.status === "failed" ? "Failed to place" : "Cancelled";
}

function Card({ card, status, busy, error, onApprove, onAnswer }: {
  card: ActionCard;
  status: ActionStatus | undefined;
  busy: boolean;
  error: string | undefined;
  onApprove: (body?: { order: string }) => void;
  onAnswer: (option: string) => void;
}) {
  const [choosing, setChoosing] = useState(false); // cart: Approve reveals when to order
  const [tab, setTab] = useState<MealChoice>(card.type === "meal-plan" ? card.plan.suggested : "cook");
  const done = status !== undefined && status !== "pending";
  const action = (label: string, doneLabel: string, onPress: () => void) => (
    <Pressable style={[s.btn, (done || busy) && s.disabled]} disabled={done || busy} onPress={onPress}>
      <Text style={s.btnText}>{busy ? "…" : done ? doneLabel : label}</Text>
    </Pressable>
  );
  let body;
  if (card.type === "cart") {
    body = (
      <>
        <Text style={s.h3}>Cart <Text style={s.muted}>· {card.cart.platform}</Text></Text>
        <Lines cart={card.cart} />
        <View style={s.rowBetween}>
          <Text style={s.h3}>Total {rupees(card.cart.total)}</Text>
          {card.needsApproval && !done && <Text style={s.warn}>needs approval</Text>}
          {!choosing || done ? action("Approve", "Approved ✓", () => setChoosing(true)) : null}
        </View>
        {choosing && !done && (
          <View style={s.options}>
            {action("Order now", "", () => onApprove({ order: "now" }))}
            {action("Order tomorrow 8 AM", "", () => onApprove({ order: tomorrowAt8() }))}
          </View>
        )}
      </>
    );
  } else if (card.type === "advance") {
    body = (
      <>
        <Text style={s.h3}>Advance {rupees(card.advance.amount)}</Text>
        <Text style={s.body}>{card.advance.reason ?? "No reason given"} · to {card.payee}</Text>
        <View style={s.rowBetween}>
          <Text style={s.muted}>{done ? "Pay again from your UPI app" : "Approve opens your UPI app"}</Text>
          {done && card.upiUrl
            ? <Pressable style={s.btn} onPress={() => void Linking.openURL(card.upiUrl!)}><Text style={s.btnText}>Pay via UPI</Text></Pressable>
            : action("Approve", "Approved ✓", onApprove)}
        </View>
      </>
    );
  } else if (card.type === "question") {
    body = (
      <>
        <Text style={s.h3}>❓ {card.text}</Text>
        <View style={s.options}>
          {card.options.map((o) => <View key={o}>{action(o, o, () => onAnswer(o))}</View>)}
        </View>
        {done && <Text style={s.muted}>Answered ✓</Text>}
      </>
    );
  } else if (card.type === "order") {
    const { order } = card;
    body = (
      <>
        <View style={s.rowBetween}>
          <Text style={s.h3}>Order</Text>
          {order.cart.platform === "mock" && <Text style={s.warn}>demo order</Text>}
        </View>
        <Text style={s.body}>{orderStatus(order)}</Text>
        <Lines cart={order.cart} />
        <View style={s.rowBetween}>
          <Text style={s.h3}>Total {rupees(order.cart.total)} <Text style={s.muted}>· cash on delivery</Text></Text>
          {action("Confirm", "Confirmed ✓", () => onApprove())}
        </View>
      </>
    );
  } else {
    const { plan } = card;
    const meals = plan[tab].meals;
    const sum = (k: keyof Macros) => Math.round(meals.reduce((n, m) => n + m.macros[k], 0));
    body = (
      <>
        <Text style={s.h3}>Tomorrow's meals <Text style={s.muted}>· {plan.date}</Text></Text>
        <Text style={s.body}>{plan.reason}</Text>
        <View style={s.tabs}>
          {(["cook", "order"] as const).map((t) => (
            <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]}>
              <Text style={[s.tabText, tab === t && s.tabTextOn]}>{t === "cook" ? "Cook" : "Order"}{plan.suggested === t ? " ★" : ""}</Text>
            </Pressable>
          ))}
        </View>
        {meals.map((m, i) => (
          <View key={i} style={s.meal}>
            <Text style={s.meta}>{m.slot}</Text>
            <Text style={s.body}>{m.dish}</Text>
            <Text style={s.muted}>≈ {m.macros.proteinG}g protein · {m.macros.carbsG}g carbs · {m.macros.fiberG}g fiber · {m.macros.kcal} kcal</Text>
            {m.searchUrl && tab === "order" && (
              <Pressable onPress={() => void Linking.openURL(m.searchUrl!)}><Text style={s.link}>Find on Swiggy</Text></Pressable>
            )}
          </View>
        ))}
        <Text style={s.total}>Day ≈ {sum("proteinG")}g protein · {sum("carbsG")}g carbs · {sum("fiberG")}g fiber</Text>
        {tab === "cook" && plan.cook.cart.lines.length > 0 && (
          <>
            <Text style={s.label}>Ingredients to buy · {rupees(plan.cook.cart.total)}</Text>
            <Lines cart={plan.cook.cart} />
          </>
        )}
        <View style={s.rowBetween}>
          <Text style={s.muted}>{done ? "Picked ✓" : plan.suggested === tab ? "Suggested from your habits" : ""}</Text>
          {card.options.includes(tab) && action(tab === "cook" ? "Cook this" : "Order this", "Picked ✓", () => onAnswer(tab))}
        </View>
      </>
    );
  }
  return (
    <View style={s.card}>
      {body}
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

const accent = "#0f6e4f";
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f6f4ef", paddingTop: Constants.statusBarHeight },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: "#e4e0d6", backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700" },
  chipBtn: { borderWidth: 1, borderColor: accent, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { color: accent, fontSize: 13, fontWeight: "600" },
  center: { flex: 1, justifyContent: "center", padding: 24, gap: 16 },
  centerText: { textAlign: "center", marginTop: 40 },
  h2: { fontSize: 20, fontWeight: "600", textAlign: "center" },
  h3: { fontSize: 16, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  muted: { color: "#77736a", fontSize: 13 },
  meta: { color: "#77736a", fontSize: 11, textTransform: "uppercase", marginBottom: 2 },
  bigBtn: { backgroundColor: accent, borderRadius: 14, padding: 20, alignItems: "center" },
  bigBtnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  cook: { padding: 20, paddingBottom: 40, alignItems: "stretch", gap: 12 },
  mic: { alignSelf: "center", width: 180, height: 180, borderRadius: 90, backgroundColor: accent, alignItems: "center", justifyContent: "center", marginTop: 16 },
  micOn: { backgroundColor: "#c0392b", transform: [{ scale: 1.08 }] },
  micIcon: { fontSize: 64, color: "#fff" },
  row: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 16 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, flexWrap: "wrap" },
  input: { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#e4e0d6", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  btn: { backgroundColor: accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  disabled: { opacity: 0.45 },
  feed: { padding: 12, paddingBottom: 40, gap: 16 },
  call: { gap: 8 },
  bubble: { backgroundColor: "#fff6dc", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#f0e2b6" },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#e4e0d6", gap: 4 },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderColor: "#f0ede6" },
  lineItem: { flex: 1, fontSize: 15 },
  price: { width: 64, textAlign: "right", fontVariant: ["tabular-nums"] },
  warn: { color: "#a55a00", backgroundColor: "#fdecd8", borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12, overflow: "hidden" },
  ok: { color: accent, fontWeight: "700", fontSize: 18 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  error: { color: "#b3261e", marginTop: 6 },
  planBtn: { alignSelf: "flex-end" },
  tabs: { flexDirection: "row", gap: 6, marginVertical: 6 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8, backgroundColor: "#f0ede6" },
  tabOn: { backgroundColor: accent },
  tabText: { fontWeight: "600", color: "#333" },
  tabTextOn: { color: "#fff" },
  meal: { paddingVertical: 6, borderBottomWidth: 1, borderColor: "#f0ede6" },
  total: { fontWeight: "600", marginTop: 6 },
  form: { padding: 16, paddingBottom: 60, gap: 10 },
  field: { gap: 4 },
  label: { color: "#55524b", fontSize: 13, fontWeight: "600" },
  seg: { borderWidth: 1, borderColor: "#d8d3c7", borderRadius: 99, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "#fff" },
  segOn: { backgroundColor: accent, borderColor: accent },
  segText: { fontSize: 14, color: "#333" },
  segTextOn: { color: "#fff", fontWeight: "600" },
  link: { color: accent, fontWeight: "600", padding: 8 },
  code: { fontSize: 56, fontWeight: "800", letterSpacing: 8, textAlign: "center", fontVariant: ["tabular-nums"] },
  codeInput: { flex: 0, fontSize: 28, letterSpacing: 6, textAlign: "center" },
});
