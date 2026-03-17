import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// Plan limits
const PLAN_LIMITS = { free: 3, starter: 25, team: 999 };

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "https://rpglens.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── 1. AUTHENTICATE USER ──────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Not authenticated. Please sign in." });
    }

    const token = authHeader.split(" ")[1];
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }

    // ── 2. CHECK PLAN & USAGE ─────────────────────────────────────────
    const plan = user.user_metadata?.plan || "free";
    const limit = PLAN_LIMITS[plan] || 3;
    const monthKey = `${new Date().getFullYear()}-${new Date().getMonth()}`;

    // Get or create usage record
    const { data: usage } = await sb
      .from("usage")
      .select("count")
      .eq("user_id", user.id)
      .eq("month_key", monthKey)
      .single();

    const currentCount = usage?.count || 0;

    if (currentCount >= limit) {
      return res.status(429).json({
        error: `Monthly limit reached. You've used ${currentCount}/${limit} analyses this month.`,
        upgrade: plan === "free"
      });
    }

    // ── 3. VALIDATE REQUEST ───────────────────────────────────────────
    const { prompt, analysisType } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "No prompt provided." });
    }
    if (prompt.length > 50000) {
      return res.status(400).json({ error: "Code too large. Maximum 50,000 characters." });
    }

    // ── 4. CALL CLAUDE API ────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });

    const result = message.content.map(b => b.type === "text" ? b.text : "").join("");

    // ── 5. INCREMENT USAGE (only on last of 4 calls = "modern" type) ──
    // We track per full analysis (4 calls). Increment on the last call.
    if (analysisType === "modern") {
      await sb.from("usage").upsert({
        user_id: user.id,
        month_key: monthKey,
        count: currentCount + 1,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,month_key" });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error("Proxy error:", err);

    if (err.status === 401) return res.status(502).json({ error: "Invalid Anthropic API key on server. Contact support." });
    if (err.status === 429) return res.status(429).json({ error: "AI service rate limited. Please wait 30 seconds and try again." });
    if (err.status === 529) return res.status(503).json({ error: "AI service overloaded. Please try again in a moment." });

    return res.status(500).json({ error: "Analysis failed. Please try again." });
  }
}
