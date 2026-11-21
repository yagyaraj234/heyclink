import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { GroceryReceipt } from "./GroceryReceipt.tsx";
import { OwnerAlerts, useCartNotification, type Tracking } from "./OwnerAlerts.tsx";
import { CartReview, PackLines, type ReviewCart } from "./CartReview.tsx";
import { API, ApiError, api, postJson, rupees } from "./api.ts";
import { authEnabled, firebase, inviteCode } from "./auth.ts";
import { JoinKitchen, ManageInvite, SignIn } from "./HouseholdAuth.tsx";
import type { Kitchen } from "./HouseholdAuth.tsx";
import type { User } from "@react-native-firebase/auth";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import type { ActionCard, CallResult, Cart, Diet, Goal, Lang, Macros, MealChoice, MealSlot, Order, Weekday } from "../src/contracts.ts";

// The seeded demo household, for skipping signup/join.
const DEMO_HOUSEHOLD = "h1";

type ActionStatus = "pending" | "approved" | "answered";
type Call = CallResult & { status: Record<string, ActionStatus>; tracking?: Record<string, Tracking>; usage?: { item: string; qty: number; unit: string; days: number; samples: number }[] };
type LooseAction = { card: ActionCard; status: ActionStatus; at: string; tracking?: Tracking };
type Role = "owner" | "cook";

type OwnerSession = { id: string; ownerToken?: string; instamartAvailable?: boolean };
type CookSession = { id: string; lang: Lang };

export default function App() {
  return authEnabled ? <AccountApp /> : <DemoApp />;
}

function AccountApp() {
  const [user, setUser] = useState<User | null>();
  const [pendingInvite, setPendingInvite] = useState<string>();
  const [startupError, setStartupError] = useState("");
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void firebase().then(auth => {
      if (active) unsubscribe = auth.onIdTokenChanged(auth.getAuth(), setUser);
    }).catch(() => { if (active) setStartupError("This build could not start sign-in."); });
    const open = (url: string) => {
      const code = inviteCode(url);
      if (code && active) setPendingInvite(code);
    };
    const link = Linking.addEventListener("url", ({ url }) => open(url));
    void Linking.getInitialURL().then(url => { if (url) open(url); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); link.remove(); };
  }, []);
  return <View style={s.screen}>
    <StatusBar style="dark" />
    {startupError ? <Text style={s.error}>{startupError}</Text>
      : user === undefined ? <ActivityIndicator />
      : user ? <HouseholdAccount key={user.uid} user={user} pendingInvite={pendingInvite}
          clearInvite={() => setPendingInvite(undefined)} />
      : <SignIn />}
  </View>;
}

function HouseholdAccount({ user, pendingInvite, clearInvite }: { user: User; pendingInvite?: string; clearInvite: () => void }) {
  const [kitchens, setKitchens] = useState<Kitchen[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [screen, setScreen] = useState<"create" | "join" | "invite" | "account" | "recover">();
  const [instamartAvailable, setInstamartAvailable] = useState(false);
  const [error, setError] = useState("");
  const [legacy, setLegacy] = useState<OwnerSession>();
  const alert = useCartNotification();
  const usedAlert = useRef<string | undefined>(undefined);
  const kitchen = kitchens?.find(item => item.id === selectedId);

  async function reload() {
    const list = await api<Kitchen[]>("/households");
    setKitchens(list);
    setError("");
    return list;
  }
  function refresh() {
    void reload().catch((e: Error) => setError(e.message));
  }
  useEffect(() => {
    refresh();
    void api<{ instamartAvailable: boolean }>("/auth/session").then(config =>
      setInstamartAvailable(config.instamartAvailable)).catch(() => {});
    void SecureStore.getItemAsync("kitchen.owner").then(raw => {
      if (!raw) return;
      const saved: OwnerSession = JSON.parse(raw);
      if (saved.id && saved.ownerToken) setLegacy(saved);
    }).catch(() => {});
    const state = AppState.addEventListener("change", next => { if (next === "active") refresh(); });
    return () => state.remove();
  }, []);
  useEffect(() => {
    if (!alert || !kitchens || usedAlert.current === alert.requestId) return;
    const owned = kitchens.filter(item => item.role === "owner");
    const target = alert.householdId ? owned.find(item => item.id === alert.householdId) : owned.length === 1 ? owned[0] : undefined;
    if (target) {
      usedAlert.current = alert.requestId;
      setScreen(undefined);
      setSelectedId(target.id);
    }
  }, [alert, kitchens]);

  function closeJoin() {
    clearInvite();
    setScreen(undefined);
  }
  function created(id: string) {
    setScreen(undefined);
    setSelectedId(id);
    refresh();
  }

  if (pendingInvite || screen === "join") return <JoinKitchen key={pendingInvite ?? "scan"} initialCode={pendingInvite} onBack={closeJoin}
    onJoin={list => { setKitchens(list); setSelectedId(undefined); closeJoin(); }} />;
  if (screen === "account") return <SignIn user={user} onLinked={() => setScreen(undefined)} onBack={() => setScreen(undefined)} />;
  if (screen === "invite" && kitchen?.role === "owner") return <ManageInvite kitchen={kitchen} onBack={() => setScreen(undefined)} />;
  if (screen === "recover" && legacy) return <RecoverKitchen saved={legacy} onBack={() => setScreen(undefined)} onDone={async () => {
    created(legacy.id);
    setLegacy(undefined);
    void SecureStore.deleteItemAsync("kitchen.owner").catch(() => {});
  }} />;
  if (screen === "create") return <>
    <View style={s.header}><Text style={s.title}>Create household</Text>
      <Pressable accessibilityRole="button" onPress={() => setScreen(undefined)}><Text style={s.link}>Back</Text></Pressable>
    </View>
    <Signup authenticated onDone={session => created(session.id)} />
  </>;

  if (kitchen) return <>
    <View style={[s.header, { gap: 8 }]}>
      <Pressable accessibilityRole="button" onPress={() => { setSelectedId(undefined); refresh(); }}><Text style={s.link}>Households</Text></Pressable>
      <Text style={[s.title, { flex: 1 }]} numberOfLines={2}>{kitchen.name}</Text>
      {kitchen.role === "owner" && <Pressable accessibilityRole="button" onPress={() => setScreen("invite")}><Text style={s.link}>Cook access</Text></Pressable>}
    </View>
    {kitchen.role === "owner"
      ? <Owner key={`${kitchen.id}:${alert?.requestId ?? ""}`} alert={alert?.cartId ?? ""} householdId={kitchen.id} instamartAvailable={instamartAvailable} />
      : <Cook key={kitchen.id} householdId={kitchen.id} lang={kitchen.lang} onAccessLost={() => {
          setSelectedId(undefined);
          refresh();
        }} />}
  </>;

  return <>
    <View style={s.header}>
      <Text accessibilityRole="header" style={s.title}>My Households</Text>
      <Pressable accessibilityRole="button" onPress={() => setScreen("account")}><Text style={s.link}>Sign-in methods</Text></Pressable>
    </View>
    <ScrollView contentContainerStyle={s.feed}>
      {kitchens?.map(item => <Pressable key={item.id} accessibilityRole="button" onPress={() => setSelectedId(item.id)} style={[s.card, { padding: 16 }]}>
        <Text style={s.h3}>{item.name}</Text>
        <Text style={s.body}>{item.location}</Text>
        <Text style={s.meta}>{item.role === "owner" ? "Owner" : "Cook"}</Text>
      </Pressable>)}
      {!kitchens && !error && <ActivityIndicator />}
      {error !== "" && <><Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={refresh}><Text style={s.link}>Reload households</Text></Pressable></>}
      <Pressable accessibilityRole="button" style={s.bigBtn} onPress={() => setScreen("join")}><Text style={s.bigBtnText}>Join a household</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => setScreen("create")}><Text style={s.link}>Create household</Text></Pressable>
      {legacy && <Pressable accessibilityRole="button" onPress={() => setScreen("recover")}><Text style={s.link}>Recover existing household</Text></Pressable>}
      <Pressable accessibilityRole="button" onPress={() => void firebase().then(auth => auth.signOut(auth.getAuth()))
        .catch(() => setError("Could not sign out. Try again."))}><Text style={s.link}>Sign out</Text></Pressable>
    </ScrollView>
  </>;
}

function RecoverKitchen({ saved, onBack, onDone }: { saved: OwnerSession; onBack: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function recover() {
    setBusy(true);
    setError("");
    try {
      await postJson("/auth/claim", { householdId: saved.id, ownerToken: saved.ownerToken, name, location });
      await onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.form}>
    <Text accessibilityRole="header" style={s.title}>Recover existing household</Text>
    <Field label="Household name" accessibilityLabel="Household name" value={name} maxLength={80} onChangeText={setName} />
    <Field label="Locality and city" accessibilityLabel="Locality and city" value={location} maxLength={120} onChangeText={setLocation} />
    <Pressable accessibilityRole="button" disabled={busy || !name.trim() || !location.trim()}
      style={[s.bigBtn, (busy || !name.trim() || !location.trim()) && s.disabled]} onPress={() => void recover()}>
      <Text style={s.bigBtnText}>Recover household</Text>
    </Pressable>
    {error !== "" && <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text>}
    <Pressable accessibilityRole="button" onPress={onBack}><Text style={s.link}>Back</Text></Pressable>
  </ScrollView>;
}

function DemoApp() {
  const [role, setRole] = useState<Role | null>(null);
  // Kept per role so one phone can demo signup on the owner side and join on the cook side.
  const [ownerHouse, setOwnerHouse] = useState<OwnerSession | null>(null);
  const [cookHouse, setCookHouse] = useState<CookSession | null>(null);
  const alert = useCartNotification();
  useEffect(() => { if (alert && ownerHouse) setRole("owner"); }, [alert, ownerHouse]);
  const [restoring, setRestoring] = useState(true);
  const [sessionError, setSessionError] = useState("");
  useEffect(() => {
    async function restore() {
      try {
        const [owner, cook] = await Promise.all(["kitchen.owner", "kitchen.cook"].map((key) => SecureStore.getItemAsync(key)));
        if (owner) setOwnerHouse(JSON.parse(owner));
        if (cook) setCookHouse(JSON.parse(cook));
      } catch {
        setSessionError("Saved kitchen could not be opened on this phone.");
      } finally {
        setRestoring(false);
      }
    }
    void restore();
  }, []);
  const remember = async (key: string, session: OwnerSession | CookSession) => {
    if (session.id === DEMO_HOUSEHOLD) return;
    try {
      await SecureStore.setItemAsync(key, JSON.stringify(session));
    } catch {
      setSessionError("Kitchen available for this session. This phone could not save it for next time.");
    }
  };
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
      {sessionError !== "" && <Text style={s.error}>{sessionError}</Text>}
      {restoring && <ActivityIndicator />}
      {!restoring && role === null && <RolePick onPick={setRole} />}
      {role === "cook" && (cookHouse ? <Cook householdId={cookHouse.id} lang={cookHouse.lang} /> : <Join onJoin={(session) => { setCookHouse(session); void remember("kitchen.cook", session); }} />)}
      {role === "owner" && (ownerHouse ? <Owner key={alert?.requestId} alert={alert?.cartId ?? ""} householdId={ownerHouse.id} ownerToken={ownerHouse.ownerToken} instamartAvailable={ownerHouse.instamartAvailable} /> : <Signup onDone={setOwnerHouse} onRegistered={(session) => remember("kitchen.owner", session)} />)}
    </View>
  );
}

function RolePick({ onPick }: { onPick: (r: Role) => void }) {
  return (
    <View style={s.center}>
      <Text style={s.h2}>Who is using this phone?</Text>
      <Pressable style={s.bigBtn} onPress={() => onPick("owner")}><Text style={s.bigBtnText}>I run the house</Text></Pressable>
      <Pressable style={s.bigBtn} onPress={() => onPick("cook")}><Text style={s.bigBtnText}>Cook · వంటవారు · रसोइया</Text></Pressable>
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

function Signup({ onDone, onRegistered, authenticated = false }: {
  onDone: (session: OwnerSession) => void | Promise<void>;
  onRegistered?: (session: OwnerSession) => Promise<void>;
  authenticated?: boolean;
}) {
  const [f, setF] = useState({ name: "", location: "", ownerName: "", ownerPhone: "", cookName: "", upiId: "", salary: "", limit: "500", protein: "" });
  const [lang, setLang] = useState<Lang>("hi");
  const [offDays, setOffDays] = useState<Weekday[]>([]);
  const [goal, setGoal] = useState<Goal>("maintain");
  const [diet, setDiet] = useState<Diet>("veg");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(OwnerSession & { cookCode: string }) | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const num = (v: string) => Number(v.replace(/[^\d.]/g, "")) || 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await postJson<OwnerSession & { cookCode: string }>("/households", {
        ...(authenticated && { name: f.name.trim(), location: f.location.trim() }),
        owner: { name: f.ownerName.trim(), ...(!authenticated && { phone: f.ownerPhone.trim() }) },
        cook: { name: f.cookName.trim(), lang, upiId: f.upiId.trim(), monthlySalary: num(f.salary), offDays },
        approvalLimit: num(f.limit),
        goals: { goal, diet, ...(f.protein ? { proteinG: num(f.protein) } : {}) },
      });
      if (authenticated) return await onDone(session);
      await onRegistered?.({ id: session.id, ownerToken: session.ownerToken, instamartAvailable: session.instamartAvailable });
      setDone(session);
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
        <Text style={s.code} selectable>{done.cookCode}</Text>
        <Text style={[s.muted, s.centerText]}>They enter it on the cook side of the app.</Text>
        <Pressable style={s.bigBtn} onPress={() => onDone({ id: done.id, ownerToken: done.ownerToken, instamartAvailable: done.instamartAvailable })}><Text style={s.bigBtnText}>Go to the feed</Text></Pressable>
      </View>
    );
  }
  const ready = f.ownerName.trim() && f.cookName.trim() && f.upiId.trim() && (authenticated ? f.name.trim() && f.location.trim() : f.ownerPhone.trim());
  return (
    <ScrollView contentContainerStyle={s.form} keyboardShouldPersistTaps="handled">
      <Text style={s.h3}>You</Text>
      <Field label="Name" value={f.ownerName} onChangeText={set("ownerName")} />
      {authenticated ? <>
        <Field label="Household name" accessibilityLabel="Household name" value={f.name} onChangeText={set("name")} maxLength={80} placeholder="Sharma Home" />
        <Field label="Locality and city" accessibilityLabel="Locality and city" value={f.location} onChangeText={set("location")} maxLength={120} placeholder="Indiranagar, Bengaluru" />
      </> : <Field label="Phone" value={f.ownerPhone} onChangeText={set("ownerPhone")} keyboardType="phone-pad" />}
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
        <Text style={s.bigBtnText}>{busy ? "…" : authenticated ? "Create household" : "Sign up"}</Text>
      </Pressable>
      {!authenticated && <Pressable onPress={() => void onDone({ id: DEMO_HOUSEHOLD })}><Text style={[s.link, s.centerText]}>Use the demo household</Text></Pressable>}
    </ScrollView>
  );
}

function Join({ onJoin }: { onJoin: (session: CookSession) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { householdId, cook } = await postJson<{ householdId: string; cook: { lang: Lang } }>("/join", { code: code.trim().toUpperCase() });
      onJoin({ id: householdId, lang: cook.lang });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={s.center}>
      <Text style={s.h2}>Kitchen code · ఇంటి కోడ్ · घर का कोड</Text>
      <TextInput style={[s.input, s.codeInput]} value={code} onChangeText={setCode} maxLength={6}
        autoCapitalize="characters" autoCorrect={false} placeholder="ABC123" />
      {error && <Text style={[s.error, s.centerText]}>{error}</Text>}
      <Pressable style={[s.bigBtn, (code.trim().length !== 6 || busy) && s.disabled]} disabled={code.trim().length !== 6 || busy} onPress={join}>
        <Text style={s.bigBtnText}>{busy ? "…" : "Join · చేరండి · जुड़ें"}</Text>
      </Pressable>
      <Pressable onPress={() => onJoin({ id: DEMO_HOUSEHOLD, lang: "hi" })}><Text style={[s.link, s.centerText]}>Demo kitchen · డెమో · डेमो</Text></Pressable>
    </View>
  );
}

// ---- Cook: hold to record, or type; both go to POST /calls --------------------

const cookCopy = {
  hi: { prompt: "दीदी/भैया को बताइए क्या चाहिए", record: "दबाकर बोलें", recording: "बोलिए… छोड़ते ही भेज देंगे", type: "या यहाँ लिखें…", send: "भेजें", sent: "भेज दिया ✓", listen: "सुनें", reply: "जवाब बोलने के लिए दबाएँ", questions: "आपसे एक सवाल", short: "थोड़ी देर तक दबाकर रखें", permission: "माइक की अनुमति नहीं मिली", choose: "यहाँ दबाकर जवाब दें", answered: "जवाब भेज दिया ✓", recap: "दूसरा सामान घरवाले देख सकते हैं।" },
  te: { prompt: "ఇంటికి ఏమి కావాలో చెప్పండి", record: "నొక్కి పట్టుకొని మాట్లాడండి", recording: "మాట్లాడండి… వదిలితే పంపబడుతుంది", type: "లేదా ఇక్కడ రాయండి…", send: "పంపండి", sent: "పంపించాం ✓", listen: "వినండి", reply: "జవాబు చెప్పడానికి నొక్కి పట్టుకోండి", questions: "మీకు ఒక ప్రశ్న", short: "కాసేపు నొక్కి పట్టుకోండి", permission: "మైక్ అనుమతి ఇవ్వండి", choose: "జవాబు ఎంచుకోండి", answered: "జవాబు పంపించాం ✓", recap: "మిగతా సరుకులు ఇంట్లోవారికి కనిపిస్తాయి." },
  en: { prompt: "What does the kitchen need?", record: "Hold to speak", recording: "Listening… release to send", type: "Or type a message…", send: "Send", sent: "Sent ✓", listen: "Listen", reply: "Hold to reply by voice", questions: "A question for you", short: "Hold a little longer to record", permission: "Allow microphone access to record", choose: "Choose your answer", answered: "Answer sent ✓", recap: "The household can review the other items already." },
};

type CookQuestion = Extract<ActionCard, { type: "question" }> & { prompt?: { text: string; options: string[] } };

type CookCard = ActionCard | { id: string; type: "cart" } |
  { id: string; type: "shared-meal"; date: string; choice: MealChoice; dishes: { slot: MealSlot; dish: string }[] };
type CookFeed = Pick<Call, "callId" | "status" | "tracking"> & { actions: CookCard[] };
type CookAction = Omit<LooseAction, "card"> & { card: CookCard };

function Cook({ householdId, lang, onAccessLost }: { householdId: string; lang: Lang; onAccessLost?: () => void }) {
  const copy = cookCopy[lang];
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [text, setText] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [calls, setCalls] = useState<CookFeed[]>([]);
  const [loose, setLoose] = useState<CookAction[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const held = useRef(false);
  const micTarget = useRef<string | null>(null);
  const startedAt = useRef(0);
  function readFeed() {
    return Promise.all([api<CookFeed[]>(`/calls?householdId=${householdId}`), api<CookAction[]>(`/households/${householdId}/actions`)]);
  }
  const load = async () => {
    const [latest, outsideCalls] = await readFeed();
    setCalls(latest);
    setLoose(outsideCalls);
  };
  useEffect(() => {
    let mounted = true;
    let loading = false;
    async function poll() {
      if (loading) return;
      loading = true;
      try {
        const [current, outsideCalls] = await readFeed();
        if (mounted) { setCalls(current); setLoose(outsideCalls); }
      } catch (e) {
        if (mounted && e instanceof ApiError && e.status === 404) onAccessLost?.();
        // Polling retries when the device reconnects.
      } finally {
        loading = false;
      }
    }
    void poll();
    const timer = setInterval(poll, 4000);
    return () => { mounted = false; clearInterval(timer); void Speech.stop(); };
  }, [householdId]);

  const send = async (init: RequestInit, question?: string) => {
    setBusy(true);
    setError("");
    try {
      if (question) {
        await api(`/actions/${question}/answer`, init);
        setSent(copy.answered);
      } else {
        const call = await api<CookFeed & Pick<Call, "transcript">>(`/calls?householdId=${householdId}&lang=${lang}`, init);
        setCalls((prev) => [call, ...prev.filter((c) => c.callId !== call.callId)]);
        setSent(`${copy.sent} · ${call.transcript.text}`);
        if (init.headers && typeof init.body === "string") setText("");
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async (target: string) => {
    if (micTarget.current !== null || busy) return;
    held.current = true;
    micTarget.current = target;
    setError("");
    try {
      await Speech.stop();
      if (!(await requestRecordingPermissionsAsync()).granted) throw new Error(copy.permission);
      if (held.current) {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
      }
      if (!held.current) { micTarget.current = null; return; }
      recorder.record();
      startedAt.current = Date.now();
      setRecording(target);
    } catch (e) {
      setError((e as Error).message);
      micTarget.current = null;
    }
  };
  const stop = async (target: string) => {
    if (micTarget.current !== target) return;
    held.current = false;
    if (!startedAt.current) return;
    const length = Date.now() - startedAt.current;
    startedAt.current = 0;
    setRecording(null);
    setBusy(true);
    try {
      await recorder.stop();
      if (length < 500 || !recorder.uri) throw new Error(copy.short);
      const blob = await (await fetch(recorder.uri)).blob();
      await send({ method: "POST", headers: { "content-type": "audio/mp4" }, body: blob }, target === "note" ? undefined : target);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      micTarget.current = null;
      setBusy(false);
    }
  };
  const microphone = (target: string) => <Pressable accessibilityRole="button"
    accessibilityLabel={target === "note" ? copy.record : copy.reply}
    disabled={busy || (recording !== null && recording !== target)}
    onPressIn={() => void start(target)} onPressOut={() => void stop(target)}
    style={target === "note" ? [s.mic, recording === target && s.micOn, busy && s.disabled] : [s.btn, recording === target && s.micOn]}>
    <Text style={target === "note" ? s.micIcon : s.btnText}>{target === "note" ? (recording === target ? "●" : "🎤") : recording === target ? copy.recording : copy.reply}</Text>
  </Pressable>;

  return (
    <ScrollView contentContainerStyle={s.cook} keyboardShouldPersistTaps="handled">
      <Text style={s.h2}>{copy.prompt}</Text>
      {microphone("note")}
      <Text style={s.muted}>{recording === "note" ? copy.recording : copy.record}</Text>
      <View style={s.row}>
        <TextInput accessibilityLabel={copy.type} style={s.input} placeholder={copy.type} value={text} onChangeText={setText} editable={!busy} />
        <Pressable accessibilityRole="button" style={[s.btn, (busy || !text.trim()) && s.disabled]} disabled={busy || !text.trim() || recording !== null} onPress={() => {
          void send({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript: text.trim() }) });
        }}><Text style={s.btnText}>{copy.send}</Text></Pressable>
      </View>
      {busy && <ActivityIndicator />}
      {sent !== "" && <Text style={s.ok}>{sent}</Text>}
      {error !== "" && <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text>}
      {[...loose.map((e) => ({ ...e, hasCart: false })), ...calls.flatMap((c) =>
        c.actions.map((card) => ({ card, status: c.status[card.id], tracking: c.tracking?.[card.id], hasCart: c.actions.some((a) => a.type === "cart") }))
      )].flatMap(({ card, status, tracking, hasCart }) => {
        const progress = tracking?.state;
        if (card.type === "cart" && (progress || tracking?.receipt)) return [
          <View key={card.id} style={s.card}>
            <GroceryReceipt receipt={tracking?.receipt} state={progress} cookLang={lang} />
          </View>,
        ];
        if (card.type === "shared-meal") return [
          <View key={card.id} style={s.card}>
            <Text style={s.h3}>{lang === "hi" ? "खाने की योजना" : lang === "te" ? "భోజన ప్రణాళిక" : "Meal plan"} · {card.date}</Text>
            {card.dishes.map(({ slot, dish }) => <Text key={slot} style={s.body}>{dish}</Text>)}
          </View>,
        ];
        if (card.type !== "question" || status !== "pending") return [];
        const question = card as CookQuestion;
        const prompt = question.prompt ?? question;
        const speak = async () => {
          await Speech.stop();
          Speech.speak([prompt.text, ...prompt.options].join(". "), {
            language: { hi: "hi-IN", te: "te-IN", en: "en-IN" }[lang],
            onError: (err) => setError(err.message),
          });
        };
        return [<View key={card.id} style={s.card}>
          <Text style={s.meta}>{copy.questions}</Text>
          <Text style={s.body}>{prompt.text}</Text>
          {hasCart && <Text style={s.muted}>{copy.recap}</Text>}
          <Pressable accessibilityRole="button" disabled={busy || recording !== null} onPress={() => void speak().catch((e: Error) => setError(e.message))}>
            <Text style={s.link}>{copy.listen}</Text>
          </Pressable>
          <Text style={s.label}>{copy.choose}</Text>
          <View style={s.options}>{question.options.map((option, i) =>
            <Pressable accessibilityRole="button" key={option} style={s.seg} disabled={busy || recording !== null}
              onPress={() => void send({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option }) }, card.id)}>
              <Text style={s.segText}>{prompt.options[i] ?? option}</Text>
            </Pressable>)}</View>
          {microphone(card.id)}
        </View>];
      })}
    </ScrollView>
  );
}

// ---- Owner: poll the calls and act on cards ---------------------------------

function Owner({ householdId, ownerToken, instamartAvailable, alert }: { householdId: string; alert: string; ownerToken?: string; instamartAvailable?: boolean }) {
  const [calls, setCalls] = useState<Call[]>([]); // newest first, as the server returns them
  const [errors, setErrors] = useState<Record<string, string>>({}); // card id (or "feed") → message
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  // cards outside any call (meal plans, their cook carts, orders from those), newest first
  const [loose, setLoose] = useState<LooseAction[]>([]);

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const options = ownerToken ? { headers: { authorization: "Bearer " + ownerToken } } : undefined;
      const [c, l] = await Promise.all([
        api<Call[]>(`/calls?householdId=${householdId}`, options),
        api<typeof loose>(`/households/${householdId}/actions`, options),
      ]);
      setCalls(c);
      setLoose(l);
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
  const approve = (card: ActionCard, body?: { order?: string; reviewId?: string }) =>
    act(card, async () => {
      const r = await postJson<{ upiUrl?: string }>(`/actions/${card.id}/approve`, body ?? {}, ownerToken);
      const upi = r.upiUrl ?? (card.type === "advance" ? card.upiUrl : undefined);
      if (upi) await Linking.openURL(upi).catch(() => { throw new Error(`Approved. No UPI app opened ${upi}`); });
    });
  const answer = (card: ActionCard, option: string) => act(card, () => postJson(`/actions/${card.id}/answer`, { option }));

  const [planning, setPlanning] = useState(false);
  const planTomorrow = async () => {
    setPlanning(true);
    setErrors(({ plan: _, ...rest }) => rest);
    try {
      await postJson(`/households/${householdId}/meal-plan`, {});
      await load();
    } catch (e) {
      setErrors((m) => ({ ...m, plan: `Plan tomorrow: ${(e as Error).message}` }));
    } finally {
      setPlanning(false);
    }
  };

  const renderCard = (card: ActionCard, status?: ActionStatus, tracking?: Tracking, fromAlert = false, pending: string[] = []) =>
    <Card key={card.id} householdId={householdId} onReload={load} ownerToken={ownerToken} instamartAvailable={instamartAvailable}
      tracking={tracking} pending={pending} fromAlert={fromAlert} card={card} status={status} busy={busy === card.id} error={errors[card.id]}
      onApprove={(body) => approve(card, body)} onAnswer={(o) => answer(card, o)} />;
  const pendingQuestions = (call?: Call) => call?.actions.flatMap((card) =>
    card.type === "question" && call.status[card.id] === "pending" ? [card.text] : []) ?? [];
  const fromCall = calls.find((call) => call.actions.some((a) => a.type === "cart" && a.id === alert));
  const alertCard = fromCall?.actions.find((a) => a.id === alert);
  const fromLoose = loose.find(({ card }) => card.type === "cart" && card.id === alert);

  return (
    <ScrollView contentContainerStyle={s.feed}>
      {alertCard && renderCard(alertCard, fromCall?.status[alert], fromCall?.tracking?.[alert], true, pendingQuestions(fromCall))}
      {fromLoose && renderCard(fromLoose.card, fromLoose.status, fromLoose.tracking, true)}
      <OwnerAlerts householdId={householdId} ownerToken={ownerToken} />
      <Pressable style={[s.btn, s.planBtn, planning && s.disabled]} disabled={planning} onPress={planTomorrow}>
        <Text style={s.btnText}>{planning ? "Planning…" : "🍽 Plan tomorrow"}</Text>
      </Pressable>
      {errors.plan && <Text style={s.error}>{errors.plan}</Text>}
      {errors.feed && <Text style={s.error}>{errors.feed}</Text>}
      {loose.filter(({ card }) => card.id !== fromLoose?.card.id)
        .map(({ card, status, tracking }) => renderCard(card, status, tracking))}
      {calls.length === 0 && loose.length === 0 && !errors.feed && <Text style={[s.muted, s.centerText]}>No notes from the cook yet.</Text>}
      {calls.map((call) => (
        <View key={call.callId} style={s.call}>
          <View style={s.bubble}>
            <Text style={s.meta}>{call.transcript.lang} · {call.transcript.provider} · {Math.round(call.timings.totalMs)} ms</Text>
            <Text style={s.body}>{call.transcript.text}</Text>
          </View>
          {call.usage?.map((u) => <Text key={u.item} style={s.muted}>{u.item} · {u.qty} {u.unit} lasted about {u.days} days ({u.samples} observed {u.samples === 1 ? "delivery" : "deliveries"}).</Text>)}
          {call.extraction.notes.map((n, i) => <Text key={i} style={s.muted}>📝 {n}</Text>)}
          {call.actions.filter((card) => card.id !== alertCard?.id)
            .map((card) => renderCard(card, call.status[card.id], call.tracking?.[card.id], false, card.type === "cart" ? pendingQuestions(call) : []))}
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

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function orderStatus(o: Order) {
  if (o.status === "scheduled") return o.scheduledFor ? `Scheduled for ${when(o.scheduledFor)}` : "Scheduled";
  if (o.status === "placed") return `Placed${o.orderId ? ` · #${o.orderId}` : ""}`;
  return o.status === "failed" ? "Failed to place" : "Cancelled";
}

function Card({ card, status, busy, error, onApprove, onAnswer, onReload, ownerToken, instamartAvailable, householdId, tracking, fromAlert, pending }: {
  pending: string[];
  tracking?: Tracking;
  fromAlert: boolean;
  householdId: string;
  onReload: () => Promise<void>;
  ownerToken?: string;
  instamartAvailable?: boolean;
  card: ActionCard;
  status: ActionStatus | undefined;
  busy: boolean;
  error: string | undefined;
  onApprove: (body?: { order?: string; reviewId?: string }) => void;
  onAnswer: (option: string) => void;
}) {
  const [tab, setTab] = useState<MealChoice>(card.type === "meal-plan" ? card.plan.suggested : "cook");
  const done = status !== undefined && status !== "pending";
  const action = (label: string, doneLabel: string, onPress: () => void) => (
    <Pressable style={[s.btn, (done || busy) && s.disabled]} disabled={done || busy} onPress={onPress}>
      <Text style={s.btnText}>{busy ? "…" : done ? doneLabel : label}</Text>
    </Pressable>
  );
  let body;
  if (card.type === "cart") {
    body = <CartReview pending={pending} fromAlert={fromAlert} tracking={tracking} demo={householdId === DEMO_HOUSEHOLD} cardId={card.id} cart={card.cart as ReviewCart} done={done} busy={busy}
      onReload={onReload} onApprove={onApprove} ownerToken={ownerToken} instamartAvailable={instamartAvailable} />;
  } else if (card.type === "advance") {
    body = (
      <>
        <Text style={s.h3}>Advance {rupees(card.advance.amount)}</Text>
        <Text style={s.body}>{card.advance.reason ?? "No reason given"} · to {card.payee}</Text>
        <View style={s.rowBetween}>
          <Text style={s.muted}>{done ? "Pay again from your UPI app" : "Approve opens your UPI app"}</Text>
          {done && card.upiUrl
            ? <Pressable style={s.btn} onPress={() => void Linking.openURL(card.upiUrl!)}><Text style={s.btnText}>Pay via UPI</Text></Pressable>
            : action("Approve", "Approved ✓", () => onApprove())}
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
        <PackLines cart={order.cart} />
        {(order.cart as ReviewCart).held?.map((line, i) => <Text key={i} style={s.warn}>Left out · {line.raw || line.item} · {line.reason}</Text>)}
        <View style={s.rowBetween}>
          <Text style={s.h3}>Total {rupees(order.cart.total)} <Text style={s.muted}>· cash on delivery</Text></Text>
          {householdId === DEMO_HOUSEHOLD && order.cart.platform === "mock" && order.cart.lines.length > 0 && (order.cart as ReviewCart).reviewId && action("Confirm demo order", "Confirmed ✓", () => onApprove({ reviewId: (order.cart as ReviewCart).reviewId }))}
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
        {tab === "cook" && (plan.cook.cart as ReviewCart).held?.map((line, i) =>
          <Text key={i} style={s.warn}>Left out · {line.raw || line.item} · {line.reason}</Text>)}
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
