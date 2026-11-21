import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Cart, CartLine, Unit } from "../src/contracts.ts";
import { CartTracking, type Tracking } from "./OwnerAlerts.tsx";
import { api, postJson, rupees } from "./api.ts";

type ReviewedLine = CartLine & { pack?: { count: number; size: number; unit: Unit }; interpretation?: string };
export type ReviewCart = Omit<Cart, "lines"> & {
  lines: ReviewedLine[];
  reviewId?: string;
  held?: { item: string; raw: string; reason: string }[];
};

function Button({ label, onPress, disabled, secondary }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
    style={[s.button, secondary && s.secondary, disabled && s.disabled]} disabled={disabled} onPress={onPress}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{label}</Text>
  </Pressable>;
}

function PackLine({ line }: { line: ReviewedLine }) {
  return <>
    <View style={s.row}>
      <Text style={s.item}>{line.item}{line.brand ? ` · ${line.brand}` : ""}</Text>
      <Text style={s.item}>{rupees(line.price)}</Text>
    </View>
    <Text>{line.qty} {line.unit}{line.pack ? ` requested · ${line.pack.count} × ${line.pack.size} ${line.pack.unit}` : ""}</Text>
    {line.interpretation && <Text style={s.notice}>{line.interpretation}</Text>}
  </>;
}

export function PackLines({ cart }: { cart: ReviewCart }) {
  return cart.lines.map((line, i) => <View style={s.line} key={i}><PackLine line={line} /></View>);
}

export function CartReview({ cardId, cart, done, busy, onReload, onApprove, ownerToken, instamartAvailable, demo, fromAlert, tracking, pending }: {
  pending: string[];
  fromAlert: boolean; tracking?: Tracking;
  cardId: string; cart: ReviewCart; done: boolean; busy: boolean; demo: boolean;
  onReload: () => Promise<void>;
  onApprove: (body: { order: string; reviewId: string }) => void;
  ownerToken?: string; instamartAvailable?: boolean;
}) {
  const [reviewed, setReviewed] = useState<ReviewCart | null>(fromAlert ? cart : null);
  const [editing, setEditing] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<Unit>("g");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const stale = reviewed !== null && reviewed.reviewId !== cart.reviewId;
  const purchased = tracking?.state === "ordered" || tracking?.state === "delivered";
  const locked = working || busy || done || purchased || stale;
  const go = async (fn: () => Promise<void>) => {
    setWorking(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      await onReload();
    } finally {
      setWorking(false);
    }
  };

  function openReview() {
    setReviewed(cart);
    setEditing(null);
    setError("");
  }
  function editLine(index: number, qty: number, editUnit: Unit) {
    if (!reviewed?.reviewId) return;
    void go(async () => {
      await postJson(`/actions/${cardId}/review`, { reviewId: reviewed.reviewId, edits: [{ index, qty, unit: editUnit }] }, ownerToken);
      setReviewed(null);
      setEditing(null);
      await onReload();
    });
  }
  const providerReview = async () => {
    if (!ownerToken || !reviewed?.reviewId) return;
    const { url } = await api<{ url: string }>(`/actions/${cardId}/instamart`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ reviewId: reviewed.reviewId }),
    });
    if (!/^https?:\/\//i.test(url)) throw new Error("Could not open the Instamart review.");
    await Linking.openURL(url);
  };

  const track = (reviewId?: string) => <CartTracking cartId={cardId} tracking={tracking} reviewId={reviewId} ownerToken={ownerToken} onReload={onReload} />;
  if (!reviewed || done || purchased) return <View style={s.section}>
    <Text style={s.title}>Grocery cart</Text>
    {cart.lines.length ? <PackLines cart={cart} /> : <Text style={s.muted}>All items removed.</Text>}
    <Text style={s.item}>Item estimate {rupees(cart.total)}</Text>
    {(done || purchased) && track(cart.reviewId)}
    {done || purchased ? <Text>Reviewed ✓</Text> : cart.lines.length > 0 && <Button label="Review order" onPress={openReview} />}
    {error !== "" && <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text>}
  </View>;

  return <View style={s.section}>
    <View style={s.row}><Text accessibilityRole="header" style={s.title}>Review order</Text>
      <Button secondary label="Close" disabled={working} onPress={() => setReviewed(null)} /></View>
    {reviewed.lines.map((line, index) => <View key={index} style={s.line}>
      <PackLine line={line} />
      {editing === index ? <>
        <TextInput accessibilityLabel={`Quantity for ${line.item}`} style={s.input}
          keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} editable={!locked} />
        <View style={s.buttons}>
          {(line.unit === "kg" || line.unit === "g" ? ["g", "kg"] as const :
            line.unit === "l" || line.unit === "ml" ? ["ml", "l"] as const : [line.unit]).map((u) =>
            <Button key={u} label={u} secondary={unit !== u} disabled={locked} onPress={() => setUnit(u)} />)}
          <Button label="Save quantity" disabled={locked || !/^\d+(\.\d+)?$/.test(quantity) || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0}
            onPress={() => editLine(index, Number(quantity), unit)} />
          <Button secondary label="Cancel edit" disabled={working} onPress={() => setEditing(null)} />
        </View>
      </> : <View style={s.buttons}>
        {reviewed.reviewId && <>
          <Button secondary label={`Edit ${line.item}`} disabled={locked} onPress={() => {
            setEditing(index); setQuantity(String(line.qty)); setUnit(line.unit);
          }} />
          <Button secondary label={`Remove ${line.item}`} disabled={locked} onPress={() => editLine(index, 0, line.unit)} />
        </>}
        {!instamartAvailable && <Button secondary label={`Find ${line.item} on Instamart`} disabled={locked}
          onPress={() => void go(() => Linking.openURL(line.searchUrl))} />}
      </View>}
    </View>)}
    {reviewed.held?.map((line, i) => <Text key={i} style={s.notice}>Left out · {line.raw || line.item} · {line.reason}</Text>)}
    {pending.map((question, i) => <Text key={i} style={s.notice}>Awaiting cook · {question}</Text>)}
    <Text style={s.item}>Item estimate {rupees(reviewed.total)}</Text>
    <Text style={s.muted}>Check your delivery address, ETA, fees and final payable total in Instamart before you pay.</Text>
    {stale && <>
      <Text accessibilityLiveRegion="polite" style={s.notice}>Your cart changed. Review the updated quantities and estimate.</Text>
      <Button label="See updated order" disabled={working} onPress={openReview} />
    </>}
    {error !== "" && <Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text>}
    {!stale && editing === null && reviewed.lines.length > 0 && reviewed.reviewId && <>
      {track(reviewed.reviewId)}
      {instamartAvailable && ownerToken && <Button label="Review with Instamart" disabled={locked} onPress={() => void go(providerReview)} />}
      {demo && <View style={s.buttons}>
        <Button label="Demo order now" disabled={locked} onPress={() => onApprove({ order: "now", reviewId: reviewed.reviewId! })} />
        <Button secondary label="Demo tomorrow at 8 AM" disabled={locked} onPress={() => {
          const date = new Date();
          date.setDate(date.getDate() + 1);
          date.setHours(8, 0, 0, 0);
          onApprove({ order: date.toISOString(), reviewId: reviewed.reviewId! });
        }} />
      </View>}
    </>}
  </View>;
}

const s = StyleSheet.create({
  section: { gap: 10 },
  line: { gap: 5, paddingVertical: 8, borderBottomWidth: 1, borderColor: "#e4e0d6" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  title: { fontSize: 18, fontWeight: "700", color: "#1a312a" },
  item: { fontSize: 16, fontWeight: "600", color: "#253832" },
  muted: { color: "#55524b", lineHeight: 19 },
  notice: { color: "#7a4c00", lineHeight: 19 },
  error: { color: "#aa2420" },
  button: { backgroundColor: "#0f6e4f", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "600" },
  secondary: { backgroundColor: "#edf2ee" },
  secondaryText: { color: "#164b3a" },
  disabled: { opacity: 0.5 },
  input: { padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#b4c1b9" },
});
