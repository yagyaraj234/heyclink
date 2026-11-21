import { StyleSheet, Text, View } from "react-native";
import type { CartLine, Lang, Unit } from "../src/contracts.ts";
import { rupees } from "./api.ts";

// The cook feed omits billing fields; the owner feed supplies them with the signed-in session.
export interface Receipt {
  receiptId?: string;
  source: "instamart" | "manual";
  lines: (Pick<CartLine, "item" | "qty" | "unit" | "brand"> & {
    pack: { count: number; size: number; unit: Unit }; price?: number;
  })[];
  total?: string;
  fees?: { label: string; value: string }[];
  address?: string;
  eta?: string;
}
const copy = {
  en: { reviewed: "Reviewed Instamart basket", ordered: "Ordered groceries", delivered: "Delivered groceries", missing: "Purchase details unavailable." },
  hi: { reviewed: "इंस्टामार्ट पर चुना सामान", ordered: "ऑर्डर किया गया सामान", delivered: "सामान आ गया", missing: "खरीद का विवरण उपलब्ध नहीं है।" },
  te: { reviewed: "ఇన్‌స్టామార్ట్‌లో ఎంచుకున్న సరుకులు", ordered: "ఆర్డర్ చేసిన సరుకులు", delivered: "సరుకులు వచ్చాయి", missing: "కొనుగోలు వివరాలు అందుబాటులో లేవు." },
};

export function GroceryReceipt({ receipt, state, cookLang }: {
  receipt?: Receipt; state?: "ordered" | "delivered"; cookLang?: Lang;
}) {
  const labels = copy[cookLang ?? "en"];
  if (!receipt && !state) return null;
  return <View style={s.section}>
    <Text accessibilityRole="header" style={s.title}>{labels[state ?? "reviewed"]}</Text>
    {receipt ? <>
      {!cookLang && <Text style={s.muted}>{receipt.source === "manual" ? "Recorded by the household · estimated prices" : "Items from this request"}</Text>}
      {receipt.lines.map((line, index) => <View style={s.row} key={index}>
        <View style={s.name}>
          <Text style={s.item}>{line.item}{line.brand ? ` · ${line.brand}` : ""}</Text>
          <Text>{line.pack.count} × {line.pack.size} {line.pack.unit}</Text>
        </View>
        {!cookLang && line.price !== undefined && <Text>{rupees(line.price)}</Text>}
      </View>)}
      {!cookLang && <>
        {receipt.fees?.map((fee, i) => <Text key={i}>{fee.label} · {fee.value}</Text>)}
        {receipt.total && <Text style={s.item}>{receipt.source === "manual" ? "Item estimate" : "Reviewed bill total"} {receipt.total}</Text>}
        {receipt.address && <Text>Deliver to {receipt.address}</Text>}
        {receipt.eta && <Text>Delivery estimate · {receipt.eta}</Text>}
      </>}
    </> : <Text style={s.muted}>{labels.missing}</Text>}
  </View>;
}

const s = StyleSheet.create({
  section: { gap: 6 },
  title: { color: "#1a312a", fontSize: 18, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 5, gap: 6 },
  name: { flex: 1, gap: 2 },
  item: { fontSize: 15, color: "#253832", fontWeight: "600" },
  muted: { color: "#55524b" },
});
