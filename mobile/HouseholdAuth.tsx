import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { encode } from "uqr";
import type { User } from "@react-native-firebase/auth";
import type { Lang } from "../src/contracts.ts";
import { ApiError, api, postJson } from "./api.ts";
import { authError, inviteCode, requestPhoneCode, signInWithGoogle } from "./auth.ts";

export type Kitchen = { id: string; name: string; location: string; lang: Lang; role: "owner" | "cook" };

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" disabled={disabled} style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]} onPress={onPress}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

export function SignIn({ user, onLinked, onBack }: { user?: User; onLinked?: () => void; onBack?: () => void }) {
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [confirm, setConfirm] = useState<{ run: (code: string) => Promise<unknown> }>();
  const [sentAt, setSentAt] = useState(0);
  const [resendReady, setResendReady] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const digits = phone.trim().replace(/[\s()-]/g, "");
  const normalized = /^\d{10}$/.test(digits) ? "+91" + digits : digits;
  const hasGoogle = user?.providerData.some(provider => provider.providerId === "google.com");
  const hasPhone = !!user?.phoneNumber;

  useEffect(() => {
    if (!sentAt) return;
    setResendReady(false);
    const timer = setTimeout(() => setResendReady(true), 30_000);
    return () => clearTimeout(timer);
  }, [sentAt]);

  async function run(action: () => Promise<void>) {
    setWorking(true);
    setError("");
    try { await action(); } catch (e) { setError(authError(e)); }
    finally { setWorking(false); }
  }

  const sendCode = () => void run(async () => {
    const next = await requestPhoneCode(normalized, user, !!confirm);
    if (!next) { onLinked?.(); return; }
    setOtp("");
    setConfirm({ run: next });
    setSentAt(Date.now());
  });

  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
    <Text accessibilityRole="header" style={styles.title}>{user ? "Sign-in methods" : "Sign in to Kitchen"}</Text>
    {hasGoogle
      ? <Text style={styles.detail}>Google linked</Text>
      : <Button disabled={working} label={user ? "Link Google" : "Continue with Google"} onPress={() => void run(async () => {
          if (await signInWithGoogle(user)) onLinked?.();
        })} />}
    {hasPhone ? <Text style={styles.detail}>Phone linked</Text> : <>
      <Text style={styles.label}>Mobile number</Text>
      <TextInput accessibilityLabel="Mobile number" autoComplete="tel" keyboardType="phone-pad"
        placeholder="+91 98765 43210" maxLength={25} editable={!confirm && !working} value={phone} onChangeText={setPhone} style={styles.input} />
      {confirm ? <>
        <Text style={styles.label}>SMS verification code</Text>
        <TextInput accessibilityLabel="SMS verification code" autoComplete="sms-otp" textContentType="oneTimeCode" keyboardType="number-pad"
          maxLength={6} value={otp} onChangeText={setOtp} style={styles.input} />
        <Button label="Verify code" disabled={working || !/^\d{6}$/.test(otp)} onPress={() => void run(async () => {
          await confirm.run(otp);
          onLinked?.();
        })} />
        <Button secondary label="Resend code" disabled={working || !resendReady} onPress={sendCode} />
        <Button secondary label="Change number" disabled={working} onPress={() => { setConfirm(undefined); setError(""); }} />
      </> : <Button secondary disabled={working || !/^\+[1-9]\d{7,14}$/.test(normalized)}
        label={user ? "Link phone" : "Continue with phone"} onPress={sendCode} />}
    </>}
    {working && <ActivityIndicator />}
    {error !== "" && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    {onBack && <Button secondary label="Back" onPress={onBack} />}
  </ScrollView>;
}

export function JoinKitchen({ initialCode, onJoin, onBack }: { initialCode?: string; onJoin: (kitchens: Kitchen[]) => void; onBack: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [camera, setCamera] = useState(false);
  const [code, setCode] = useState(initialCode ?? "");
  const [preview, setPreview] = useState<{ name: string; code: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function find(value: string) {
    if (inFlight.current) return;
    setCamera(false);
    const validCode = inviteCode(value);
    if (!validCode) { setError("Scan a Kitchen QR or enter the invite code."); return; }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setCode(validCode);
    try {
      const { name } = await postJson<{ name: string }>("/join/preview", { code: validCode });
      setPreview({ name, code: validCode });
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  useEffect(() => { if (initialCode) void find(initialCode); }, [initialCode]);

  async function join() {
    if (!preview || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { onJoin(await postJson<Kitchen[]>("/join", { code: preview.code })); }
    catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function scan() {
    if (permission?.granted || (await requestPermission()).granted) setCamera(true);
    else setError("Camera access is off. Enter the invite code below.");
  }

  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
    <Text accessibilityRole="header" style={styles.title}>{preview ? `Join ${preview.name}?` : "Join a household"}</Text>
    {preview ? <Button label="Join household" disabled={busy} onPress={() => void join()} /> : <>
      {camera
        ? <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void find(data)} />
        : <Button label="Scan QR" disabled={busy} onPress={() => void scan().catch(() => setError("Camera unavailable. Enter the invite code below."))} />}
      <Text style={styles.label}>Invite code</Text>
      <TextInput accessibilityLabel="Invite code" style={styles.input} autoCapitalize="characters" autoCorrect={false}
        value={code} maxLength={24} onChangeText={setCode} placeholder="XXXX-XXXX-XXXX" />
      <Button secondary label="Continue" disabled={busy || !code.trim()} onPress={() => void find(code)} />
    </>}
    {busy && <ActivityIndicator />}
    {error !== "" && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <Button secondary label="Back" onPress={onBack} />
  </ScrollView>;
}

type InviteState = { cookJoined: boolean; expiresAt: string | null };
type Invite = { code: string; url: string; expiresAt: string };

function InviteQr({ url }: { url: string }) {
  const qr = encode(url, { border: 4, ecc: "M" });
  const module = Math.floor(220 / qr.size);
  return <View accessible accessibilityLabel="Household invite QR code" style={styles.qr}>
    {qr.data.map((row, y) => <View key={y} style={styles.qrRow}>
      {row.map((dark, x) => <View key={x} style={{ width: module, height: module, backgroundColor: dark ? "#000" : "#fff" }} />)}
    </View>)}
  </View>;
}

export function ManageInvite({ kitchen, onBack }: { kitchen: Kitchen; onBack: () => void }) {
  const [state, setState] = useState<InviteState>();
  const [invite, setInvite] = useState<Invite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/households/${kitchen.id}`;
  const refresh = async () => {
    const current = await api<InviteState>(path + "/invites");
    setState(current);
    setInvite(previous => previous?.expiresAt === current.expiresAt ? previous : undefined);
  };
  useEffect(() => {
    const load = () => void refresh().catch((e: Error) => setError(e.message));
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [path]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const revoke = (suffix: string) => void run(async () => {
    await postJson(path + suffix, {});
    await refresh();
  });
  const code = invite?.code.match(/.{4}/g)?.join("-");
  return <ScrollView contentContainerStyle={styles.form}>
    <Text accessibilityRole="header" style={styles.title}>Cook access</Text>
    <Text style={styles.detail}>{kitchen.name}</Text>
    {state?.cookJoined ? <>
      <Text>Cook joined this household.</Text>
      <Button secondary disabled={busy} label="Remove cook access" onPress={() => Alert.alert(
        "Remove cook access?", "The cook will lose access to this household.", [
          { text: "Cancel", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: () => revoke("/cook/revoke") },
        ],
      )} />
    </> : <>
      {invite && <>
        <InviteQr url={invite.url} />
        <Text selectable style={styles.code}>{code}</Text>
        <Button label="Share invite" disabled={busy} onPress={() => void Share.share({
          message: `Join ${kitchen.name} in Kitchen\n${invite.url}\nInvite code: ${code}`,
        }).catch(() => setError("Could not share the invite. Copy the code above."))} />
      </>}
      {state?.expiresAt && <>
        <Text style={styles.detail}>Invite expires {new Date(state.expiresAt).toLocaleString()}.</Text>
        <Button secondary disabled={busy} label="Cancel invite" onPress={() => revoke("/invites/cancel")} />
      </>}
      {!invite && <Button disabled={busy || !state} label={state?.expiresAt ? "Replace invite" : "Generate cook invite"}
        onPress={() => void run(async () => {
          const next = await postJson<Invite>(path + "/invites", {});
          setState({ cookJoined: false, expiresAt: next.expiresAt });
          setInvite(next);
        })} />}
    </>}
    {(!state || busy) && !error && <ActivityIndicator />}
    {error !== "" && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <Button secondary label="Back" onPress={onBack} />
  </ScrollView>;
}

const groceryRetailers = [
  { id: "instamart", name: "Instamart", url: "https://www.swiggy.com/instamart" },
  { id: "zepto", name: "Zepto", url: "https://www.zepto.com/" },
  { id: "blinkit", name: "Blinkit", url: "https://blinkit.com/" },
] as const;
type GroceryRetailer = (typeof groceryRetailers)[number];
type GroceryStatus = "available" | "connected" | "reconnect";
type GroceryStatuses = Partial<Record<GroceryRetailer["id"], GroceryStatus | "unavailable" | "error">>;

export function ManageGroceryAccounts({ kitchen, onBack }: { kitchen: Kitchen; onBack: () => void }) {
  const [statuses, setStatuses] = useState<GroceryStatuses>({});
  const [busy, setBusy] = useState<GroceryRetailer["id"]>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const path = `/households/${encodeURIComponent(kitchen.id)}/grocery-accounts/`;

  useEffect(() => {
    let active = true;
    for (const { id } of groceryRetailers) {
      if (id === "blinkit") continue;
      void api<{ status: GroceryStatus }>(path + id)
        .then(({ status }) => status)
        .catch((e: unknown) => e instanceof ApiError && e.status === 404 ? "unavailable" as const : "error" as const)
        .then(status => { if (active) setStatuses(previous => ({ ...previous, [id]: status })); });
    }
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") setRefresh(value => value + 1);
    });
    return () => { active = false; subscription.remove(); };
  }, [path, refresh]);

  async function run(retailer: GroceryRetailer, action: () => Promise<unknown>) {
    setBusy(retailer.id);
    setError("");
    try {
      await action();
    } catch {
      setError(`Could not update ${retailer.name}. Try again.`);
    } finally {
      setBusy(undefined);
    }
  }

  return <ScrollView contentContainerStyle={styles.form}>
    <Text accessibilityRole="header" style={styles.title}>Grocery accounts</Text>
    <Text style={styles.detail}>{kitchen.name}</Text>
    {groceryRetailers.map(retailer => {
      const { id, name, url } = retailer;
      const status = id === "blinkit" ? "unavailable" : statuses[id];
      const statusLabel = {
        available: "Ready to connect", connected: "Connected", reconnect: "Sign in again",
        unavailable: "Account linking unavailable", error: "Could not load connection",
      };
      return <View key={id} style={styles.retailer}>
        <Text accessibilityRole="header" style={styles.label}>{name}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.detail}>{status ? statusLabel[status] : "Checking connection…"}</Text>
        {(status === "connected" || status === "reconnect") && <Button secondary label={`Disconnect ${name}`} disabled={!!busy}
          onPress={() => Alert.alert(`Disconnect ${name}?`, "This removes saved account access for this household.", [
            { text: "Cancel", style: "cancel" },
            { text: "Disconnect", style: "destructive", onPress: () => void run(retailer, async () => {
              await api(path + id, { method: "DELETE" });
              setStatuses(previous => ({ ...previous, [id]: "available" }));
              setRefresh(value => value + 1);
            }) },
          ])} />}
        {(status === "available" || status === "reconnect") && <Button
          label={status === "reconnect" ? `Reconnect ${name}` : `Connect ${name}`} disabled={!!busy}
          onPress={() => void run(retailer, async () => {
            const response = await postJson<{ url: string }>(path + id, {});
            await Linking.openURL(response.url);
          })} />}
        {status === "unavailable" && <Button secondary label={`Open ${name}`} disabled={!!busy}
          onPress={() => void run(retailer, () => Linking.openURL(url))} />}
        {status === "error" && <Button secondary label={`Retry ${name}`} disabled={!!busy}
          onPress={() => setRefresh(value => value + 1)} />}
        {busy === id && <ActivityIndicator accessibilityLabel={`Updating ${name}`} />}
      </View>;
    })}
    {error !== "" && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <Button secondary label="Back" onPress={onBack} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  retailer: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e4e0d6", padding: 12, gap: 8 },
  form: { padding: 24, paddingBottom: 40, gap: 13 },
  title: { fontSize: 25, fontWeight: "700", color: "#22251e" },
  label: { color: "#45483f", fontWeight: "600" },
  detail: { color: "#53534a", fontSize: 15 },
  input: { backgroundColor: "#fff", borderColor: "#d8d3c7", borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
  button: { backgroundColor: "#0f6e4f", minHeight: 48, justifyContent: "center", alignItems: "center", padding: 12, borderRadius: 10 },
  secondary: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#0f6e4f" },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondaryText: { color: "#0f6e4f" },
  disabled: { opacity: 0.5 },
  error: { color: "#9b2119" },
  camera: { width: "100%", height: 260, borderRadius: 12, overflow: "hidden" },
  qr: { alignSelf: "center", backgroundColor: "#fff", padding: 8 },
  qrRow: { flexDirection: "row" },
  code: { fontSize: 20, fontWeight: "700", textAlign: "center", letterSpacing: 2 },
});
