import { defineConfig } from "vite";

// API lives on the Express server; in prod it serves web/dist from the same origin.
const api = Object.fromEntries(["/calls", "/actions", "/households"].map((p) => [p, "http://localhost:3000"]));

export default defineConfig({ server: { proxy: api }, preview: { proxy: api } });
