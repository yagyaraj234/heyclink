import { test } from "node:test";
import assert from "node:assert/strict";
import { connectInstamart } from "./instamart-client.ts";

test(
  "live Instamart can read saved addresses",
  { skip: process.env.LIVE !== "1" || !process.env.INSTAMART_ACCESS_TOKEN },
  async () => {
    const client = await connectInstamart(process.env.INSTAMART_ACCESS_TOKEN!, fetch, process.env.INSTAMART_STAGING === "1");
    const data = await client.addresses(1);
    assert.ok(Array.isArray(data.addresses));
    assert.equal(typeof data.pagination.hasMore, "boolean");
  },
);
