import { useEffect, useState } from "react";
import { Button, Platform, Text, View } from "react-native";
import Constants from "expo-constants";
import { api } from "./api.ts";

export type Tracking = { state?: "ordered" | "delivered"; remindAt?: string };
type Notifications = typeof import("expo-notifications");

async function notifications(): Promise<Notifications> {
  if (Platform.OS === "web" || Constants.executionEnvironment === "storeClient") {
    throw new Error("Grocery alerts require the installed Kitchen app.");
  }
  return import("expo-notifications");
}

function ownerPost<T>(path: string, token: string, body: object) {
  return api<T>(path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function useCartNotification() {
  const [alert, setAlert] = useState<{ cartId: string; requestId: string } | null>(null);
  useEffect(() => {
    let active = true;
    let subscription: ReturnType<Notifications["addNotificationResponseReceivedListener"]> | undefined;
    void notifications().then(async n => {
      if (!active) return;
      const handle = (response: ReturnType<Notifications["getLastNotificationResponse"]>) => {
        const id = response?.notification.request.content.data?.cartId;
        if (active && response && typeof id === "string") {
          setAlert({ cartId: id, requestId: response.notification.request.identifier });
          n.clearLastNotificationResponse();
        }
      };
      subscription = n.addNotificationResponseReceivedListener(handle);
      handle(n.getLastNotificationResponse());
    }).catch(() => {});
    return () => { active = false; subscription?.remove(); };
  }, []);
  return alert;
}

export function OwnerAlerts({householdId, ownerToken}: {householdId: string; ownerToken?: string}) {
  const [status, setStatus] = useState("");
  const [working, setWorking] = useState(false);
  if (!ownerToken) return null;
  async function enable() {
    setWorking(true);
    try {
      const n = await notifications();
      const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
      if (!projectId) throw new Error("This build needs its Expo project ID to enable grocery alerts.");
      if (Platform.OS === "android") await n.setNotificationChannelAsync("groceries", {name:"Grocery requests", importance:n.AndroidImportance.HIGH});
      const permission = await n.requestPermissionsAsync();
      if (!permission.granted) throw new Error("Allow notifications in your phone settings to receive grocery requests.");
      const {data} = await n.getExpoPushTokenAsync({projectId});
      await ownerPost("/households/" + householdId + "/alerts", ownerToken!, {token: data});
      setStatus("Grocery alerts enabled");
    } catch (e) { setStatus(e instanceof Error ? e.message : "Could not enable grocery alerts"); }
    finally { setWorking(false); }
  }
  return <View>
    {status !== "Grocery alerts enabled" && <Button title="Enable grocery alerts" disabled={working} onPress={enable} />}
    {status !== "" && <Text accessibilityLiveRegion="polite">{status}</Text>}
  </View>;
}

export function CartTracking({cartId, ownerToken, tracking, reviewId, onReload}: {
  cartId: string; ownerToken?: string; tracking?: Tracking; reviewId?: string; onReload: () => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  if (!ownerToken) return null;
  async function update(body: object) {
    setWorking(true);
    setError("");
    try {
      await ownerPost("/actions/" + cartId + "/tracking", ownerToken!, {...body, reviewId});
      await onReload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update cart"); }
    finally { setWorking(false); }
  }
  function remind() {
    const at = new Date();
    at.setHours(18,0,0,0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate()+1);
    void update({remindAt: at.toISOString()});
  }
  return <View>
    {tracking?.state === "delivered" ? <Text>Delivered</Text> : tracking?.state === "ordered" ?
      <Button title="Mark delivered" disabled={working} onPress={() => void update({state:"delivered"})} /> : <>
        <Button title="I bought these items" disabled={working} onPress={() => void update({state:"ordered"})} />
        {tracking?.remindAt ? <Text>Reminder set for {new Date(tracking.remindAt).toLocaleString()}</Text> :
          <Button title={new Date().getHours() < 18 ? "Remind me at 6 PM today" : "Remind me at 6 PM tomorrow"} disabled={working} onPress={remind} />}
      </>}
    {error !== "" && <Text accessibilityLiveRegion="polite">{error}</Text>}
  </View>;
}
