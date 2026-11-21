import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import type { ActionCard, CallResult } from "../src/contracts.ts";

// The API runs on the same machine as the Expo dev server, so default to its LAN host on :3000.
const API = process.env.EXPO_PUBLIC_API_URL ?? `http://${(Constants.expoConfig?.hostUri ?? "localhost").split(":")[0]}:3000`;
// ponytail: fixed demo household until signup/join (PR 2) hands out real ids.
const HOUSEHOLD = "h1";

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
      {role === "cook" && <Cook />}
      {role === "owner" && <Owner />}
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

// ---- Cook: hold to record, or type; both go to POST /calls --------------------

function Cook() {
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
      const call = await api<CallResult>(`/calls?householdId=${HOUSEHOLD}`, { method: "POST", ...init });
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
          void send({ headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: HOUSEHOLD, transcript: text.trim() }) });
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

function Owner() {
  const [calls, setCalls] = useState<Call[]>([]); // newest first, as the server returns them
  const [errors, setErrors] = useState<Record<string, string>>({}); // card id (or "feed") → message
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setCalls(await api<Call[]>(`/calls?householdId=${HOUSEHOLD}`));
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
  const approve = (card: ActionCard) =>
    act(card, async () => {
      const r = await api<{ upiUrl?: string }>(`/actions/${card.id}/approve`, { method: "POST" });
      const upi = r.upiUrl ?? (card.type === "advance" ? card.upiUrl : undefined);
      if (upi) await Linking.openURL(upi).catch(() => { throw new Error(`Approved. No UPI app opened ${upi}`); });
    });
  const answer = (card: ActionCard, option: string) => act(card, () => postJson(`/actions/${card.id}/answer`, { option }));

  return (
    <ScrollView contentContainerStyle={s.feed}>
      {errors.feed && <Text style={s.error}>{errors.feed}</Text>}
      {calls.length === 0 && !errors.feed && <Text style={[s.muted, s.centerText]}>No notes from the cook yet.</Text>}
      {calls.map((call) => (
        <View key={call.callId} style={s.call}>
          <View style={s.bubble}>
            <Text style={s.meta}>{call.transcript.lang} · {call.transcript.provider} · {Math.round(call.timings.totalMs)} ms</Text>
            <Text style={s.body}>{call.transcript.text}</Text>
          </View>
          {call.extraction.notes.map((n, i) => <Text key={i} style={s.muted}>📝 {n}</Text>)}
          {call.actions.map((card) => (
            <Card key={card.id} card={card} status={call.status[card.id]} busy={busy === card.id} error={errors[card.id]}
              onApprove={() => approve(card)} onAnswer={(o) => answer(card, o)} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function Card({ card, status, busy, error, onApprove, onAnswer }: {
  card: ActionCard;
  status: ActionStatus | undefined;
  busy: boolean;
  error: string | undefined;
  onApprove: () => void;
  onAnswer: (option: string) => void;
}) {
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
        {card.cart.lines.map((l, i) => (
          <View key={i} style={s.line}>
            <Text style={s.lineItem}>{l.item}{l.brand ? ` · ${l.brand}` : ""}</Text>
            <Text style={s.muted}>{l.qty} {l.unit}</Text>
            <Text style={s.price}>{rupees(l.price)}</Text>
          </View>
        ))}
        <View style={s.rowBetween}>
          <Text style={s.h3}>Total {rupees(card.cart.total)}</Text>
          {card.needsApproval && <Text style={s.warn}>needs approval</Text>}
          {action("Approve", "Approved ✓", onApprove)}
        </View>
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
  } else {
    body = <Text style={s.muted}>{card.type} card: coming in the next update</Text>;
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
});
