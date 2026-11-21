import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { expoPush } from "./alerts.ts";

const device = process.env.EXPO_TEST_DEVICE_TOKEN;
test("Expo accepts a grocery alert for the opted-in test device", {skip: process.env.LIVE !== "1" || !device}, async () => {
  await expoPush(device!, randomUUID(), "ready");
});
